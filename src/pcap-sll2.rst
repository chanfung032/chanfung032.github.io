pcap 库怎么获取抓到包的网卡信息
=================================

pcap 的基本使用
----------------------

pcap 包处理函数的原型一般是这样的：

.. code-block:: c

    void packet_handler(u_char *args, const struct pcap_pkthdr *pkthdr, const u_char *p);

第三个参数指向一个 buffer，这个 buffer 里是网络包的数据。第二个参数 `pcap_pkthdr` 中只有下面这 3 个字段，记录跟这个网络包相关的一些元数据，然而并没有网卡相关的信息。

.. code-block:: c

    struct pcap_pkthdr {
        struct timeval ts;  // 时间戳
        bpf_u_int32 caplen; // 抓到的包的长度，可能截断了
        bpf_u_int32 len;    // 包的实际长度
    }

那 ``tcpdump -i any -e`` （底层用的 pcap 库）看到的网卡信息等是怎么来的呢。

DLT_LINUX_SLL2 模式
---------------------------

翻 tcpdump 和 pcap 库的代码，发现在网卡是 ``any`` 的情况下，可以通过  ``pcap_set_datalink(handle, DLT_LINUX_SLL2)`` 这个调用让 pcap 库切换到 DLT_LINUX_SLL2 模式去，这个模式下，第二个参数返回不变，第三个参数网络包中的 *以太网包头* 会被一个 *伪包头* 替换掉，这个 *伪包头* 里包含了网卡号，包的类型流向等一些额外信息。

完整的使用代码如下：

.. code-block:: c

    void packet_handler(u_char *args, const struct pcap_pkthdr *pkthdr, const u_char *p) {
        // 网络包的一开始是 伪包头
        const struct sll2_header *sllp = (const struct sll2_header *)p;
        uint32_t if_index = ntohl(sllp->sll2_if_index);
        char ifname[IF_NAMESIZE];
        if (!if_indextoname(if_index, ifname))
            strncpy(ifname, "?", 2);

        // 后面开始是 IP 包头，以太网包头被前面的伪包头替换掉了
        p += SLL2_HDR_LEN;
        len = pkthdr->len - SLL2_HDR_LEN;

        printf("Nic: %s, Packet Length: %d %s\n", ifname, len);
        ...
    }

    int main() {
        ...
        // 需要是 any 网卡的时候，设置 DLT_LINUX_SLL2 才会生效
        handle = pcap_open_live("any", 65536, 1, 1000, errbuf);
        pcap_set_datalink(handle, DLT_LINUX_SLL2);

        pcap_loop(handle, 0, packet_handler, NULL);
        ...
    }

如果编译的时候报 ``DLT_LINUX_SLL2`` 找不到，需要升级 pcap 库。

``sll2_header`` 完整的字段如下：

.. code-block:: c

    struct sll2_header {
        // ether type 802.3/802.1Q/...
        uint16_t sll2_protocol;
        uint16_t sll2_reserved_mbz;
        // 网卡号
        uint32_t sll2_if_index;
        uint16_t sll2_hatype;
        // 包类型，可以是 HOST/BROADCAST/MULTICAST/OTHERHOST/OUTGOING
        uint8_t  sll2_pkttype;
        uint8_t  sll2_halen;
        // 网卡 MAC 地址
        uint8_t  sll2_addr[SLL_ADDRLEN];
    };

还是用 tcpdump 来看一看这个里面可以打印出的一些信息， ``tcpdump -i any -e -XX`` 可以看到包的网卡、流向等信息，注意下面 16 进制打印出来的前 20 个字节就是这个 ``sll2_header`` 了，并不是实际的以太网包头。

.. code-block:: console

    # tcpdump -i any -e -XX
    tcpdump: data link type LINUX_SLL2 👈 运行在 SLL2 模式下
    tcpdump: verbose output suppressed, use -v[v]... for full protocol decode
    listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 262144 bytes
    07:37:36.139372 eth0  In  ifindex 2 48:57:02:f4:e2:92 (oui Unknown) ethertype IPv4 (0x0800), length 72: bogon.59104 > arch.10022: Flags [.], ack 474860, win 1156, options [nop,nop,TS val 1170175875 ecr 1805243877], length 0
        0x0000:  0800 0000 0000 0002 0001 0006 4857 02f4  ............HW..
        0x0010:  e292 0000 4540 0034 0000 4000 3e06 0dd9  ....E@.4..@.>...
        ...                👆 从这里开始是 IP 包头

更多细节可以参见 tcpdump 项目中 sll2 相关的打印代码： https://github.com/the-tcpdump-group/tcpdump/blob/master/print-sll.c