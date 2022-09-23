#220919 配置
=======================

数组的指定初始化 Designated Initializers
----------------------------------------------

内核代码中看到的如下初始化数组方法：

.. code-block:: c

    struct ipv4_devconf {
        int	data[IPV4_DEVCONF_MAX];
    };

    static struct ipv4_devconf ipv4_devconf = {
        .data = {
            [IPV4_DEVCONF_ACCEPT_REDIRECTS - 1] = 1,
            [IPV4_DEVCONF_SEND_REDIRECTS - 1] = 1,
            [IPV4_DEVCONF_SECURE_REDIRECTS - 1] = 1,
            [IPV4_DEVCONF_SHARED_MEDIA - 1] = 1,
            [IPV4_DEVCONF_IGMPV2_UNSOLICITED_REPORT_INTERVAL - 1] = 10000 /*ms*/,
            [IPV4_DEVCONF_IGMPV3_UNSOLICITED_REPORT_INTERVAL - 1] =  1000 /*ms*/,
            [IPV4_DEVCONF_ARP_EVICT_NOCARRIER - 1] = 1,
        },
    };

这个是 GUN C 扩展语法，除了指定位置的值被初始化为指定值之后，其余值都为被设为默认值 0。

https://gcc.gnu.org/onlinedocs/gcc/Designated-Inits.html

网络相关的配置都存在哪
------------------------

以 rp_filter 为例，每个网络设备有自己单独的配置，另外还有两个全局（更准确的说是网络命名空间）的配置 all 和 default。

.. code-block:: console

    # sysctl -ar '\.rp_filter'
    net.ipv4.conf.all.rp_filter = 0
    net.ipv4.conf.default.rp_filter = 2
    net.ipv4.conf.eth0.rp_filter = 2
    net.ipv4.conf.lo.rp_filter = 2

这些配置直接映射到 ``/proc/sys/net`` 目录下对应的文件：

.. code-block:: console

    # find /proc/sys/net  -name "rp_filter"
    /proc/sys/net/ipv4/conf/all/rp_filter
    /proc/sys/net/ipv4/conf/default/rp_filter
    /proc/sys/net/ipv4/conf/eth0/rp_filter
    /proc/sys/net/ipv4/conf/lo/rp_filter

读取、修改 sysctl 配置就是读取、修改 proc 文件系统里这些文件。

网卡对应的配置和网络命名空间对应的配置分别挂在 ``struct net_device`` 和 ``struct net`` 之下。

.. image:: images/sysctl-data.svg

IPv4 相关的配置项存在下面这个结构体的 data 数组中，每个配置项一个槽位。

.. code-block:: c

    struct ipv4_devconf {
        void *sysctl;
        int   data[IPV4_DEVCONF_MAX];
        DECLARE_BITMAP(state, IPV4_DEVCONF_MAX);
    };

内核提供了一系列的宏来方便单独获取或者合并获取某个配置项的值。

在这些宏的基础之上再封装出某个具体配置项的宏，比如：

.. code-block:: c

    #define IN_DEV_RPFILTER(in_dev)	IN_DEV_MAXCONF((in_dev), RP_FILTER)

如果不清楚某个配置项具体的获取规则，可以直接看 https://elixir.bootlin.com/linux/v5.19/source/include/linux/inetdevice.h 。