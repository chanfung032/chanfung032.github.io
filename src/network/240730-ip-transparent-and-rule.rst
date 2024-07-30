#240730 IP_TRANSPARENT 和策略路由
=========================================

IP_TRANSPARENT 和策略路由可以用来 bind 或者 accept 非本机 IP。

bind
-------------

.. code-block:: python

    import socket

    IP_TRANSPARENT = 19

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # 注释掉下面这行绑定会失败
    # strace 看 bind 系统调用会返回 EADDRNOTAVAIL (Cannot assign requested address)
    s.setsockopt(socket.SOL_IP, IP_TRANSPARENT, 1)
    s.bind(('8.8.8.8', 8080))

IP_TRANSPARENT + bind 可以用来修改发送的 IP 包的源地址，比如可以用来把真实 IP 带给后端服务器，而不是使用 TOA 之类的内核模块通过 TCP Option 字段带过去，当然这样后端服务器上也需要特殊的路由规则才能让响应包原路返回。

具体可以参见 Nginx 的透明代理实现：https://github.com/vislee/leevis.com/issues/142

内核默认不允许 bind 非本机 IP， IP_TRANSPARENT 可以帮助跳过这个判断。

.. code-block:: c

    sys_bind
    |- sock->ops->bind/inet_bind/...
    |- __inet_bind
        |- chk_addr_ret = inet_addr_type_table(net, addr->sin_addr.s_addr, tb_id)
        |- if (!net->ipv4.sysctl_ip_nonlocal_bind &&
        |      !(inet->freebind || inet->transparent) &&
        |      addr->sin_addr.s_addr != htonl(INADDR_ANY) &&
        |      chk_addr_ret != RTN_LOCAL &&
        |      chk_addr_ret != RTN_MULTICAST &&
        |      chk_addr_ret != RTN_BROADCAST)
        |    goto out;

accept
---------------

要 accept 非本机的 IP，需要 IP_TRANSPARENT 和策略路由的配合。

首先，策略路由。

.. code-block:: bash

    ip route add local 0.0.0.0/0 dev lo table 100
    ip rule add fwmark 1 table 100
    iptables -t mangle -A PREROUTING -i lo -p tcp -d 8.8.8.8 -j MARK --set-xmark 0x1/0x1

上面这 3 条命令我们创建了一个新的路由表 100，这个表里面所有的 IPv4 地址都被认为是本机 IP，然后我们通过 iptables + ip rule 让 lo 口发给 8.8.8.8 的包使用路由表 100，在这个特殊的表里面这个 IP 被认为是一个本机 IP，从而 8.8.8.8 这个包不会被 IP 层（ ``ip_route_input_*`` ）丢弃，可以顺利到达 TCP 层。

第二步，给监听的 socket 设置 IP_TRANSPARENT。

.. code-block:: python

    import socket
    import time

    IP_TRANSPARENT = 19

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IP, IP_TRANSPARENT, 1)

    s.bind(('0.0.0.0', 80))
    s.listen(32)
    print("[+] Bound to tcp://0.0.0.0:80")
    while True:
        c, (r_ip, r_port) = s.accept()
        l_ip, l_port = c.getsockname()
        print("[ ] Connection from tcp://%s:%d to tcp://%s:%d" % (r_ip, r_port, l_ip, l_port))
        print(c.recv(1024))
        c.send(b"hello world\n")
        c.close()

下面是 TCP 服务端发送 syn ack 中路由相关的逻辑，如果 socket 设置了 IP_TRANSPARENT，查询路由时会加上 FLOWI_FLAG_ANYSRC 标志位。

.. code-block:: c

    // tcp_v4_rcv > tcp_v4_do_rcv > tcp_rcv_state_process > tcp_conn_request
    tcp_conn_request
    |- inet_rsk(req)->no_srccheck = inet_sk(sk)->transparent;
    |- af_ops->send_synack()/tcp_v4_send_synack/tcp_v6_send_synack
    |- inet_csk_route_req
        |- flowi4_init_output(fl4,
        |    ...,
        |    inet_sk_flowi_flags(sk),
        |    |- if (inet_sk(sk)->transparent || inet_sk(sk)->hdrincl)
        |    |    flags |= FLOWI_FLAG_ANYSRC;
        |    |  return flags;
        |    ...);
        |- rt = ip_route_output_flow(net, fl4, sk)

这个标志位让查询路由时，忽略检测源地址是否是本机 IP。

.. code-block:: c

    struct rtable *ip_route_output_key_hash_rcu(struct net *net, struct flowi4 *fl4,
            struct fib_result *res,
            const struct sk_buff *skb)
        ...
        if (!(fl4->flowi4_flags & FLOWI_FLAG_ANYSRC)) {
            /* It is equivalent to inet_addr_type(saddr) == RTN_LOCAL */
            if (!__ip_dev_find(net, fl4->saddr, false))
                goto out;
        }
        ...
    }

运行服务器程序，然后在相同的机器上用以下方式访问，访问成功。

.. code-block:: console
    
    # curl --interface lo 8.8.8.8:80
    [ ] Connection from tcp://127.0.0.1:39435 to tcp://8.8.8.8:80
    GET / HTTP/1.1
    User-Agent: curl/7.29.0
    Host: 8.8.8.8
    Accept: */*


    hello world