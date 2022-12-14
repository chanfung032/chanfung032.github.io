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