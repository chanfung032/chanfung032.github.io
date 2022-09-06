#220826 网络栈接收数据 RX | 协议栈
===============================================

RPS 和 RFS
-----------------

::

    gro_normal_one
      |- gro_normal_list
        |- netif_receive_skb_list_internal
          |- if unlikely(rps_needed):
          |    foreach skb:
          |      |- cpu = get_rps_cpu(skb)
          |      |- skb_list_del_init(skb)
          |      |- enqueue_to_backlog(skb, cpu)
          |
          |- __netif_receive_skb_list

在 GRO 之后， ``__netif_receive_skb_list`` 函数中，如果启用 RPS（基本不会），skb 包会被重新均衡到各个 CPU，这是一个软件层面的 RSS 实现，详细可参见：https://www.kernel.org/doc/Documentation/networking/scaling.txt

__netif_receive_skb_list_core: 往各种协议层投送包
------------------------------------------------------

调用栈： ::

    |- netif_receive_skb_list_internal
      |- __netif_receive_skb_list
        |- __netif_receive_skb_list_core
          |- foreach skb:
          |   |- __netif_receive_skb_core
          |     |- skb_reset_network_header
          |     |
          |     |- do_xdp_generic
          |     |
          |     |- for ptype in ptype_all:
          |     |    deliver_skb(ptype, skb)
          |     |- for ptype in skb->dev->ptype_all:
          |     |    deliver_skb(ptype, skb)
          |     |
          |     |- if skb_vlan_tag_present(skb):
          |     |    vlan_do_receive(skb)
          |     |
          |     |- sch_handle_ingress
          |     |- nf_ingress
          |     |- if skb->dev->rx_handler:
          |     |    skb->dev->rx_handler(skb)
          |     |
          |     |- deliver_ptype_list_skb(ptype_base[ntohs(skb->protocol)])
          |     |- deliver_ptype_list_skb(skb->dev->ptype_specific)
          |     |
          |     |- return last ptype
          |
          |- __netif_receive_skb_list_ptype
            |- pt_prev->list_func/ip_list_rcv

``__netif_receive_skb_list_core`` 承担了将 skb 投送到上层协议栈的工作，这个函数调用栈看起来复杂，尤其是 ``__netif_receive_skb_list_core`` 函数，做了下面这一堆事：

1. 设置 iphdr 指针指向了当前 skb->data。
2. ``do_xdp_generic``，调用 generic xdp 程序，如果有的话。
3. 投送 skb 给抓包程序， ``deliver_skb`` 给 ``ptype_all`` （tcpdump -i any）、 ``skb->dev->ptype_all`` （tcpdump -i <dev>） 。
4. 如果 mac header 中有 vlan tag，处理 vlan tag。
5. ``sch_handle_ingress``，过 tc 规则，执行 tc-bpf 程序。
6. 执行 ``skb->dev->rx_handler``，bond 之类的网卡设备可能会用到这个 handler。
7. 投送 skb 给网络层 ``ip_rcv/ip6_rcv/arp_rcv`` 函数。这个回调一般不会直接在这个函数中执行，会延后到 ``__netif_receive_skb_list_ptype`` 函数中去执行，具体后面会详细说。

当然现实大部分情况是：没有抓包程序、没有 tc 规则、没有 tc-bpf 程序、没有 vlan tag、普通网卡，那这个函数就只是找到上层网络协议层的回调函数，然后将其返回。很简单。

``__netif_receive_skb_list_core`` 函数记录上面返回的最后那个回调函数，相同回调函数的 skb 会被一起调 ``__netif_receive_skb_list_ptype`` 函数批量投送给上面网络层，比如 IP 包会调用 ``ip_list_rcv`` 函数，对，不是 ``ip_rcv``，而是 ``ip_list_rcv`` 这个批量版。

ptype_* 网络层处理函数
-------------------------

网络层的各种处理函数都保存在下面这四个变量中：

.. code-block:: c

    // 全局变量
    // 数组，用 网络协议号 &0xf 作 key，每个元素为一个处理函数列表
    struct list_head ptype_base[PTYPE_HASH_SIZE] __read_mostly;
    struct list_head ptype_all __read_mostly;

    // 网络设备关联变量
    struct net_device {
        //...
        struct list_head	ptype_all;
        struct list_head	ptype_specific;
        //...
    };

每个网络协议层在初始化的时候会调用 ``dev_add_pack`` 注册协议的处理函数，比如 IP 协议（ETH_P_IP）注册的处理函数是 ``ip_rcv/ip_list_rcv`` 函数。

.. code-block:: c

    static struct packet_type ip_packet_type __read_mostly = {
        .type = cpu_to_be16(ETH_P_IP),
        .func = ip_rcv,
        .list_func = ip_list_rcv,
    };

    static int __init inet_init(void)
    {
        //...
        dev_add_pack(&ip_packet_type);
        //...
    }

``dev_add_pack`` 会将抓包类的处理函数追加到 ``ptype_all`` 或者具体网络设备的 ``dev->ptype_all`` 中。将具体协议相关的按照协议号注册到 ``ptype_base`` 中。

.. code-block:: c

    void dev_add_pack(struct packet_type *pt)
    {
        struct list_head *head = ptype_head(pt);

        spin_lock(&ptype_lock);
        list_add_rcu(&pt->list, head);
        spin_unlock(&ptype_lock);
    }

    static inline struct list_head *ptype_head(const struct packet_type *pt)
    {
        if (pt->type == htons(ETH_P_ALL))
            return pt->dev ? &pt->dev->ptype_all : &ptype_all;
        else
            return pt->dev ? &pt->dev->ptype_specific :
                &ptype_base[ntohs(pt->type) & PTYPE_HASH_MASK];
    }

我们可以通过 proc 看到这些注册上来的 ptype（只显示了 .func 函数）：

.. code-block:: console

    # cat /proc/net/ptype
    Type Device      Function
    0800          ip_rcv
    0806          arp_rcv
    86dd          ipv6_rcv

奇怪的 pt_prev
-----------------------

上面说到 ``__netif_receive_skb_list_core`` 函数中没有调用最后一个 ptype 处理函数，而是将这个处理函数返回，最后在 ``__netif_receive_skb_list_ptype`` 调用。这个的实现以及为什么和代码中出现的一个奇怪的变量 ``pt_prev`` 有关。

看下代码：

.. code-block:: c

    list_for_each_entry_rcu(ptype, &ptype_all, list) {
        if (pt_prev)
            ret = deliver_skb(skb, pt_prev, orig_dev);
        pt_prev = ptype;
    }

    list_for_each_entry_rcu(ptype, &skb->dev->ptype_all, list) {
        if (pt_prev)
            ret = deliver_skb(skb, pt_prev, orig_dev);
        pt_prev = ptype;
    }

所有 ptype 回调函数都不是直接调用，而是先保存到一个 ``pt_prev`` 变量中，然后发现新的 ptype 回调函数时，再调用投送函数将 skb 投送给 ``pt_prev``，也就是前一个 ptype 回调函数，然后最后一个函数不直接调用，要返回然后再在另外一个函数里执行，为什么？

.. code-block:: c

    // __netif_receive_skb_list_core 函数中
    list_for_each_entry_rcu(ptype, &ptype_all, list) {
        if (pt_prev)
            ret = deliver_skb(skb, pt_prev, orig_dev);
        pt_prev = ptype;
    }

    // __netif_receive_skb_list_ptype 函数中
    if (pt_prev->list_func != NULL)
        INDIRECT_CALL_INET(pt_prev->list_func, ipv6_list_rcv,
            ip_list_rcv, head, pt_prev, orig_dev);
    else
        list_for_each_entry_safe(skb, next, head, list) {
            skb_list_del_init(skb);
            pt_prev->func(skb, skb->dev, pt_prev, orig_dev);
        }

这个其实是 Linux 做的一个优化，所有前面的投送都是通过 ``deliver_skb`` 这个函数，而最后一个是直接调用 ptype 处理函数。

.. code-block:: c

    static inline int deliver_skb(struct sk_buff *skb,
        struct packet_type *pt_prev, struct net_device *orig_dev)
    {
        if (unlikely(skb_orphan_frags_rx(skb, GFP_ATOMIC)))
            return -ENOMEM;
        refcount_inc(&skb->users);
        return pt_prev->func(skb, skb->dev, pt_prev, orig_dev);
    }

这两个的差别在于 ``deliver_skb`` 在调用 ptype 处理函数之前会先增加 skb 的引用计数，而所有的 ptype 处理函数在一开始都会调用 `skb_share_check <https://www.kernel.org/doc/htmldocs/networking/API-skb-share-check.html>`_ 函数，这个函数的功能就是检查 skb 是不是共享的，共不共享就是通过 skb 的引用计数判断的，如果是共享的， 会先 ``skb_clone(skb)`` ，后续所有操作都基于 clone 出来的新 skb。

.. code-block:: c

    static inline struct sk_buff *skb_share_check(struct sk_buff *skb, gfp_t pri)
    {
        if (skb_shared(skb)) {
            struct sk_buff *nskb = skb_clone(skb, pri);
            // 这个会 skb_unref(skb) 导致 skb 引用计数减 1
            consume_skb(skb);
            skb = nskb;
        }
        return skb;
    }

也就是说，优化点是：除了最后一个 ptype 处理函数，前面所有的处理函数都因为 skb 引用计数不为 1，得先 clone 一份 skb 再使用，只有最后一个处理函数引用计数为 1 不用 clone。而在只有一个 ptype 处理函数的一般正常情况下，也就不会有任何 clone。

References:

- https://blog.csdn.net/sinat_20184565/article/details/79496663

L3 网络层
-----------------

网络层主要做的是以下几件事：

1. 校验包，比如 iphdr，checksum 之类。
2. 执行 netfilter prerouting hook， iptables PREROUTING 链的规则会在这里执行，执行完包没有被丢弃的话会调用 ``ip_rcv_finish`` 继续往下执行。
3. ``ip_rcv_finish_core`` 中会查询获得本包的路由。
4. 如果路由给本地，调用 ``ip_local_deliver`` 函数继续往下执行。
5. 如果 IP 包被分片了，重组。
6. 执行 netfilter input hook，iptables INPUT 链的规则会在这里执行，执行完包没有被丢弃的话会调用 ``ip_local_deliver_finish`` 继续往下执行。
7. ``skb_pull`` 剥除掉 iphdr，将包投送给上面传输层协议对应的处理函数： ``tcp_v4_rcv/udp_rcv`` 。

调用栈： ::

    ip_rcv
    |- ip_rcv_core
    |  |- ip_fast_csum
    |- NF_HOOK(NFPROTO_IPV4, NF_INET_PRE_ROUTING, ip_rcv_finish)
       |- if nf_hook(NFPROTO_IPV4, NF_INET_PRE_ROUTING)
            ip_rcv_finish
            |- ip_rcv_finish_core
            |  |- if net->ipv4.sysctl_ip_early_demux
            |  |    tcp_v4_early_demux(skb)/udp_v4_early_demux(skb)
            |  |    |- sk = __inet_lookup_established
            |  |    |- if sk
            |  |         skb_dst_set(skb, sk->sk_rx_dst)
            |  |         return
            |  |- ip_route_input_noref
            |     |- ip_route_input_rcu
            |        |- ip_route_input_slow
            |           |- fib_lookup
            |           |- fib_validate_source
            |           |- rth = rt_dst_alloc
            |           |  |- rth->dst.dev = ip_rt_get_dev()
            |           |  |- rth->dst.input = ip_local_deliver
            |           |- skb_dst_set(skb, rth->dst)         |
            |                                                 |
            |- dst_input                                      |
               |- skb_dst(skb)->input/ip_local_deliver     <--'
                  |- if ip_is_fragment: ip_defrag()
                  |
                  |- NF_HOOK(NFPROTO_IPV4, NF_INET_LOCAL_IN, ip_local_deliver_finish)
                       if nf_hook(NFPROTO_IPV4, NF_INET_LOCAL_IN)
                         ip_local_deliver_finish
                         |- __skb_pull(skb, skb_network_header_len(skb))
                         |- ip_protocol_deliver_rcu(skb, ip_hdr(skb)->protocol)
                            |- ipprot = inet_protos[protocol]
                            |- ipprot->handler/tcp_v4_rcv/udp_rcv(skb)

``sysctl_ip_early_demux`` 是一个查询路由的优化，默认一般都是打开的。这个优化会直接调用上面传输层的函数提前获取这个网络包归属的 socket，从里面获取缓存的路由，不用没次都查路由表了（比较慢）。

.. code-block:: console

  # sysctl -ar 'ip_early_demux'
  net.ipv4.ip_early_demux = 1

传输层协议对应的处理函数是在 IP 网络层的初始化函数 ``inet_init`` 中注册的。

.. code-block:: c

    static int __init inet_init(void)
    {
      //...
      if (inet_add_protocol(&icmp_protocol, IPPROTO_ICMP) < 0)
        pr_crit();
      if (inet_add_protocol(&udp_protocol, IPPROTO_UDP) < 0)
        pr_crit();
      if (inet_add_protocol(&tcp_protocol, IPPROTO_TCP) < 0)
        pr_crit();
      //...
    }

    static const struct net_protocol tcp_protocol = {
        .handler = tcp_v4_rcv,
    };

    static const struct net_protocol udp_protocol = {
        .handler = udp_rcv,
    };

    static const struct net_protocol icmp_protocol = {
        .handler = icmp_rcv,
    };

    int inet_add_protocol(const struct net_protocol *prot, unsigned char protocol)
    {
        return !cmpxchg((const struct net_protocol **)&inet_protos[protocol],
              NULL, prot) ? 0 : -1;
    }

L4 传输层
----------------

（UDP 协议比较简单，先用 UDP 协议来说明好了，TCP 核心做的事跟这个类似，但要复杂得多，后续再说）。

UDP 层做的事主要如下：

1. 调用 ``__udp4_lib_lookup_skb`` 获取本 skb 包是归属于哪个 socket 的。
2. 检查该 socket 的接收队列 buffer 是不是满了，如果满了直接丢弃包。
3. 将 skb 加入到该 socket 的接收队列中并更新 buffer 长度。
4. 通知上层应用程序有数据来了，来 ``recv*`` 数据啦。

调用栈：

::

    udp_rcv
    |- __udp4_lib_rcv
       |- sk = __udp4_lib_lookup_skb
       |- udp_unicast_rcv_skb(sk, skb)
          |- udp_queue_rcv_skb
             |- udp_queue_rcv_one_skb
                |- __udp_queue_rcv_skb
                   |- __udp_enqueue_schedule_skb
                      |- rmem = atomic_read(&sk->sk_rmem_alloc);
                      |- if (rmem > sk->sk_rcvbuf)
                      |     goto drop
                      |- atomic_add_return(skb->truesize, &sk->sk_rmem_alloc)
                      |
                      |- list = &sk->sk_receive_queue
                      |- __skb_queue_tail(list, skb)
                      |- sk->sk_data_ready/sock_def_readable(sk)

至此，一个网络包经过网络栈的层层处理，最终在某一个 socket 的接收队列里静静躺着，等待应用程序调用 ``recv*`` 函数来消费了。

.. image:: images/sk.svg

网络栈的上下两部分
----------------------

网络栈一般在逻辑上被分成上下两个部分：

- 上半部分（Top Half），也叫控制路径（control path），这部分在进程的内核态中执行，socket 的创建、修改、操作、关闭都在这个部分中执行。
- 下半部分（Bottom Half），也叫数据路径（data path）、fast path，这部分在软中断中执行。负责将数据从网卡送到 socket 的接收队列中，将 socket 发送队列的数据送到网卡发送出去。

有些函数带 **bh** 前缀或者后缀，比如 ``bh_lock_sock``，表示这个是给 **B**\ ottom **H**\ alf 使用的。