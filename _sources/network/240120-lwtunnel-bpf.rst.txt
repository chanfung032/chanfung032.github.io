#240120 使用 lwtunnel bpf 写隧道控制面程序
=============================================

使用 ``ip link`` 只能创建点对点的静态隧道，点多了之后，两两互联就需要创建大量的隧道，会产生一大堆的虚拟网卡设备，管理起来麻烦，解决的一个方法就是使用 lwtunnel（Light Weight Tunnel 轻量级隧道），将复杂的隧道控制/路由逻辑移到路由表中，lwtunnel 还支持挂载 bpf 程序，可以进一步将逻辑移到 bpf map 中，灵活的实现更加复杂的控制路由逻辑。

lwtunnel 支持以下 3 种 bpf 程序：

- BPF_PROG_TYPE_LWT_IN
- BPF_PROG_TYPE_LWT_OUT
- BPF_PROG_TYPE_LWT_XMIT

在内核中的调用入口： https://elixir.bootlin.com/linux/latest/source/net/core/lwt_bpf.c

这 3 种 bpf 程序中比较有用的 BPF_PROG_TYPE_LWT_XMIT 类型的 bpf 程序，一般隧道控制面都是使用这个类型。

    Programs attached to input and output are read-only. Programs attached to lwtunnel_xmit() can modify and redirect, push headers and redirect packets.
    
    https://lwn.net/Articles/708020/

一个简单的 BPF_PROG_TYPE_LWT_XMIT 程序：

.. code-block:: c

    SEC("encap_gre")
    int bpf_lwt_encap_gre(struct __sk_buff *skb)
    {
        struct encap_hdr {
                struct iphdr iph;
                struct grehdr greh;
        } hdr;
        int err;

        memset(&hdr, 0, sizeof(struct encap_hdr));

        hdr.iph.ihl = 5;
        hdr.iph.version = 4;
        hdr.iph.ttl = 0x40;
        hdr.iph.protocol = 47;          // IPPROTO_GRE
        hdr.iph.saddr = 0xa601a8c0;     // 192.168.1.165
        // 现实程序中目标 IP 可以从 bpf map 中查询
        hdr.iph.daddr = 0xa501a8c0;     // 192.168.1.166
        hdr.iph.tot_len = bpf_htons(skb->len + sizeof(struct encap_hdr));
        hdr.greh.protocol = skb->protocol;

        err = bpf_lwt_push_encap(skb, BPF_LWT_ENCAP_IP, &hdr,
                                sizeof(struct encap_hdr));
        if (err)
            return BPF_DROP;

        return BPF_LWT_REROUTE;
    }

编译为 bpf object 文件，加载使用以下命令：

::

    ip route add <route> encap bpf xmit obj <bpf obj file.o> section <ELF section> dev <device>


最后，创建给这个隧道用的网卡以及添加隧道 IP，创建网卡的时候使用 ``external`` 关键字（要不得指定隧道的 local 和 remote 参数）。

.. code-block:: console

    # ip link add gre01 type gre external
    # ip a add <ip/mask> dev gre01

隧道包的解包和静态隧道一样，内核处理，不用管了。

----

BPF_PROG_TYPE_LWT_IN 也可以调用 bpf_lwt_push_encap 函数，使用场景是？

https://elixir.bootlin.com/linux/v5.19/source/net/core/filter.c#L8061

----

其他示例程序：

- 数据面 https://github.com/torvalds/linux/blob/master/tools/testing/selftests/bpf/progs/test_lwt_redirect.c
- 控制面 https://github.com/torvalds/linux/blob/master/tools/testing/selftests/bpf/prog_tests/lwt_redirect.c
