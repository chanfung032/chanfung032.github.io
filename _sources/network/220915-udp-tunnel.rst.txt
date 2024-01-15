#220915 UDP 隧道
=========================

收包处理路径
------------------

以 fou 隧道为例，隧道创建的时候，会创建一个 udp socket，并设置其对应的 ``udp_sock.encap_rcv`` 为 ``fou_udp_recv`` 函数。 ::

   fou_create(struct net *net, struct fou_cfg *cfg, struct socket **sockp)
   |- struct socket *sock = NULL
   |- udp_sock_create(net, &cfg->udp_config, &sock)
   |  ...
   |- struct udp_tunnel_sock_cfg tunnel_cfg
   |- tunnel_cfg.encap_rcv = fou_udp_recv
   |  ...
   |- setup_udp_tunnel_sock(net, sock, &tunnel_cfg)
      |- struct sock *sk = sock->sk
      |  ...
      |- udp_sk(sk)->encap_rcv = tunnel_cfg->encap_rcv
      |  ...

通过 netstat 可以看到这个 socket。

.. code-block:: console

   # ip fou add port 19523
   # netstat -nlu
   Active Internet connections (only servers)
   Proto Recv-Q Send-Q Local Address           Foreign Address         State
   ...
   udp        0      0 0.0.0.0:19523           0.0.0.0:*
   ...

然后 udp_rcv 函数中会判断找到的 udp socket 的 ``encap_rcv`` 是不是为空，为空，走正常路径，如果不为空，则走隧道路径。

.. code-block:: diff

      udp_rcv
      |- __udp4_lib_rcv
         |- sk = __udp4_lib_lookup_skb
         |- udp_unicast_rcv_skb(sk, skb)
            |- udp_queue_rcv_skb
               |- udp_queue_rcv_one_skb
    +             |- struct udp_sock *up = udp_sk(sk)
    +             |- if up->encap_type
    +             |     ret = up->encap_rcv(sk, skb)
    +             |     if ret <= 0
    +             |        return -ret
                  |- __udp_queue_rcv_skb

``encap_rcv`` 回调函数的返回值有以下三种情况：

1. 等于 0，这个包被隧道层处理函数丢弃掉了，直接返回即可。
2. 大于 0，内层包的协议也是 UDP，继续往下执行。
3. 小于 0，这种内层封包的协议不是 UDP，需要回溯到网络层，在 ``ip_local_deliver_finish`` 中重新投送。

.. code-block:: diff

      ip_local_deliver_finish
      |- ip_protocol_deliver_rcu(skb, ip_hdr(skb)->protocol)
    +    |resubmit:
         |- ipprot = inet_protos[protocol]
         |- ret = ipprot->handler/tcp_v4_rcv/udp_rcv/tunnel4_rcv/tunnel64_rcv(skb)
    +    |- if ret < 0
    +         protocol = -ret
    +         goto resubmit

``inet_protos`` 里除了普通传输层协议的各种处理函数，还有各种隧道协议注册的处理函数。

.. code-block: c

   static const struct net_protocol tunnel4_protocol = {
      .handler	=	tunnel4_rcv,
   };

   static const struct net_protocol tunnel64_protocol = {
      .handler	=	tunnel64_rcv,
   };

   static int __init tunnel4_init(void)
   {
      ...
      inet_add_protocol(&tunnel4_protocol, IPPROTO_IPIP)
      inet_add_protocol(&tunnel64_protocol, IPPROTO_IPV6)
      ...
   }

解包
---------------

首先在 fou 模块的设置的 ``encap_rcv`` 回调函数 ``fou_udp_recv`` 中。剥除外层的 UDP 头，将传输层指向内层 IP/IPv6 包的开头。然后回调函数返回 ``-IPPROTO_IPIP`` 或者 ``-IPPROTO_IPV6`` 来调用通用的解包函数来接包。

.. code-block:: c

   static int fou_recv_pull(struct sk_buff *skb, struct fou *fou, size_t len)
   {
      // 从外层 IP 包中减去 UDP 头的大小
      if (fou->family == AF_INET)
         ip_hdr(skb)->tot_len = htons(ntohs(ip_hdr(skb)->tot_len) - len);
      else
         ipv6_hdr(skb)->payload_len =
             htons(ntohs(ipv6_hdr(skb)->payload_len) - len);
   
      // 剥除 UDP 协议头
      __skb_pull(skb, len);
      // 更新外层 IP 包的 checksum
      skb_postpull_rcsum(skb, udp_hdr(skb), len);
      // 更新传输层指向内层 IP 包的开头
      skb_reset_transport_header(skb);
      return iptunnel_pull_offloads(skb);
   }
   
   static int fou_udp_recv(struct sock *sk, struct sk_buff *skb)
   {
      struct fou *fou = fou_from_sock(sk);
   
      if (!fou)
         return 1;
   
      if (fou_recv_pull(skb, fou, sizeof(struct udphdr)))
         goto drop;
   
      // 返回 fou 隧道的协议，可能是 IPPROTO_IPIP、IPPROTO_IPV6
      return -fou->protocol;
   
   drop:
      kfree_skb(skb);
      return 0;
   }

如果是一个 IPv6 in IPv4 的包。那就是返回 ``-IPPROTO_IPV6``，回到 IP 层 resubmit 后就到了 ``tunnel64_rcv`` 这个回调函数中。

.. code-block:: c

   static int tunnel64_rcv(struct sk_buff *skb)
   {
      struct xfrm_tunnel *handler;
   
      if (!pskb_may_pull(skb, sizeof(struct ipv6hdr)))
         goto drop;
   
      for_each_tunnel_rcu(tunnel64_handlers, handler)
         if (!handler->handler(skb))
            return 0;
   
      icmp_send(skb, ICMP_DEST_UNREACH, ICMP_PORT_UNREACH, 0);
   
   drop:
      kfree_skb(skb);
      return 0;
   }

sit 模块在初始化的时候会调用 ``xfrm4_tunnel_register`` 注册 ``IPPROTO_IPV6`` 的处理函数 ``ipip6_rcv`` 。

.. code-block:: c

   static struct xfrm_tunnel sit_handler __read_mostly = {
      .handler =	ipip6_rcv,
      .err_handler =	ipip6_err,
      .priority =	1,
   };

   static int __init sit_init(void)
   {
      ...
      err = xfrm4_tunnel_register(&sit_handler, AF_INET6);
      ...
   }

tunnel64_rcv 中会遍历所有注册的处理 IPv6 in IPv4 的包的处理函数并调用。就会调用到 ``ipip6_rcv`` 。

.. code-block:: c

   static int ipip6_rcv(struct sk_buff *skb)
   {
      // 这个是外层 IP 头
      const struct iphdr *iph = ip_hdr(skb);
      ...
      tunnel = ipip6_tunnel_lookup(dev_net(skb->dev), skb->dev,
                  iph->saddr, iph->daddr, sifindex);
      if (tunnel) {
         ...

         // 让 iphdr 指针指向内层 IPv6 头
         skb_reset_network_header(skb);
  
         ...

         // 重新提交包到协议栈网络层
         netif_rx(skb);

         return 0;
      }

      /* no tunnel matched,  let upstream know, ipsec may handle it */
      return 1;
   }

GRO 没起作用？
-----------------

5.13 前内核的 UDP 隧道 有个 GRO 的 BUG，UDP 包的 checksum 为 0 的时候， ``udp_gro_receive`` 函数中会误认为不满足合并包的条件而提前终止，所以 GUE 这一类的 UDP 隧道协议虽然早就实现了协议对应的 ``gro_receive``、 ``gro_complete`` 处理函数，但是因为 GRO 在 UDP 层提前终止了，实际还是没有起作用。

详细见：https://github.com/torvalds/linux/commit/89e5c58fc1e2857ccdaae506fb8bc5fed57ee063

虽然物理网卡这一层的 GRO 没有生效，但是对于 ``IPPROTO_IPIP`` 类型的隧道协议包，在解包之后 redirect 到对应的逻辑网卡时还有一次 GRO 机会。 ::

   ipip_rcv
   |- ipip_tunnel_rcv(skb, IPPROTO_IPIP)
      |- ip_tunnel_rcv
         |- gro_cells_receive
            |- if (!gcells->cells || skb_cloned(skb) || !(dev->features & NETIF_F_GRO))
            |    netif_rx(skb)
            |    return
            |- __skb_queue_tail(&cell->napi_skbs, skb)
            |- napi_schedule(&cell->napi)

这个看到的现象就是 tcpdump 看物理网卡上收到的 UDP 隧道协议包都是大小 1500 以下的小包，但是在隧道对应的逻辑网卡上抓包看到的内层包能看到 1500 以上的大包。

IPPROTO_IPV6 协议没有，详细可以看上面 ``ipip6_rcv`` 函数， ``ipip6_rcv`` 没有做第二次 GRO。

内核 UDP 性能相关的一些优化和版本：https://developers.redhat.com/articles/2021/11/05/improve-udp-performance-rhel-85

外层 checksum 速算法与 LCO
----------------------------------

不升级内核解决上面 GRO 没生效的一个方法就是填上外面隧道层 UDP 头中的 checksum 字段。外层 checksum 有快速算法。

先看 TCP/UDP 协议是如何计算头里的 checksum 字段的。

.. image:: images/tcp-checksum.png

首先，TCP/UDP 计算 checksum 的时候，除了 TCP/UDP 包自身的数据外，还包含一部分从 IP 层提取的数据（源/目的地址等），这部分数据一般称为 pseduo-header 伪头。计算 checksum 的时候是对这两个数据来做计算。

计算的方法是将这部分数据按照 2 个字节一组作二进制循环加法(循环的意思是如果加完后溢出，溢出的部分要加到低位去)，最后加完后取其补码，将补码填到 TCP/UDP 的 checksum 字段中。计算的时候 checksum 字段填 0。

校验的时候还按照计算的方法，对这部分数据计算其 checksum，此时 checksum 已经填上了值，因为 checksum 是剩余部分的补码，所以此时计算出的结果应该是 ``0xffff``，如果计算结果不是这个，说明传输的数据包有问题。

.. code-block:: c

   checksum(pseudo-header) + checksum(tcp-segment) = 0xffff

https://en.wikipedia.org/wiki/Transmission_Control_Protocol#Checksum_computation

根据 checksum 计算方法可以得出：填上了 checksum 字段后，TCP 包的 checksum 就是 pseudo-header 的 checksum 的反码。好了，大头部分的 checksum 已经快速算完了，剩余部分（外层 pseduo-header，外层 UDP 头、内层 IP 头等）的 checksum 正常计算然后和速算部分相加就可以了。

这个速算方法就是内核中 LCO（Local Checksum Offload）的原理。详细见：

- https://www.kernel.org/doc/html/v5.10/networking/checksum-offloads.html
- https://elixir.bootlin.com/linux/v6.4.8/source/include/linux/skbuff.h#L5043

TSO/GSO
------------------

veth 测隧道 TSO 没有问题，但虚拟机 virtio 驱动下 TSO 似乎都有问题？（待进一步测试），在 veth 上测，GRO/GSO 关闭开启对性能影响不是特别大，但是 TSO 对性能影响巨大。

各种隧道类型
--------------

https://developers.redhat.com/blog/2019/05/17/an-introduction-to-linux-virtual-interfaces-tunnels

发包处理路径
---------------

udp 隧道的封包一般是在虚拟网卡的驱动中去做的，以 fou 隧道为例：

.. code-block:: console

   # ip link add name tun1 type ipip remote 192.168.1.1 local 192.168.1.2 encap fou encap-sport auto encap-dport 5555

从 fou 隧道的创建命令可以看出，fou 隧道底层实际上创建的是一个 ipip 隧道，只不过参数中指定了封包的类型为 fou。

.. code-block:: c

   static const struct net_device_ops ipip_netdev_ops = {
      ...
      .ndo_start_xmit	= ipip_tunnel_xmit,
      ...
   };

ipip 类型的虚拟网卡设置的其网络驱动层的发包函数为 ``ipip_tunnel_xmit``，这个函数会根据注册的封包协议找到对应的封包函数，封包，然后和其他 ipip 包一样去处理。

::

   ipip_tunnel_xmit
   |- ...
   |- struct ip_tunnel *tunnel = netdev_priv(dev);
   |- ip_tunnel_xmit(skb, dev, tiph, ipproto);
      |- ...
      |- ip_tunnel_encap(skb, tunnel, ...);
      |  |- ...
      |  |- ops = rcu_dereference(iptun_encaps[tunnel->encap.type])
      |  |- ops->build_header(skb, &t->encap, protocol, fl4)
      |  |- ....
      |
      |- iptunnel_xmit(NULL, rt, skb, fl4.saddr, fl4.daddr, protocol, ...);
         |- ...
         |- skb_push(skb, sizeof(struct iphdr));
         |- skb_reset_network_header(skb);
         |- iph = ip_hdr(skb);
         |- iph->version = 4;
         |- ...
         |- ip_local_out(net, sk, skb);
         |- ...

对应的封包函数是 fou 模块在初始化的时候注册的。

.. code-block:: c

   // fou_init 调用本函数注册 fou 封包的回调函数
   static int ip_tunnel_encap_add_fou_ops(void)
   {
      ...
      ret = ip_tunnel_encap_add_ops(&fou_iptun_ops, TUNNEL_ENCAP_FOU);
      ...
   }
   int ip_tunnel_encap_add_ops(const struct ip_tunnel_encap_ops *ops, unsigned int num)
   {
      ...
      return !cmpxchg((const struct ip_tunnel_encap_ops **)
            &iptun_encaps[num],
            NULL, ops) ? 0 : -1;
   }

   static const struct ip_tunnel_encap_ops fou_iptun_ops = {
      .encap_hlen = fou_encap_hlen,
      .build_header = fou_build_header,
      .err_handler = gue_err,
   };

因为封包是在网络驱动层去做的，在抓包程序的挂载点（网络设备层）之下，所以从虚拟网卡上可以抓包看到原始要发送的包。