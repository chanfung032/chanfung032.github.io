#220915 UDP 隧道
---------------------

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