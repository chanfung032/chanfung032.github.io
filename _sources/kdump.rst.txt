如何解决一个内核崩溃问题
===========================

通过 kdump 获取内核崩溃现场
---------------------------

内核崩溃的时候如果不能通过管理控制台获取最后的现场信息，可以通过 kdump 工具来转储崩溃现场。

   kdump is a feature of the Linux kernel that creates crash dumps in
   the event of a kernel crash. When triggered, kdump exports a memory
   image (also known as vmcore) that can be analyzed for the purposes of
   debugging and determining the cause of a crash. 

   –- https://en.wikipedia.org/wiki/Kdump\_(Linux)

CentOS 系统一般预装了 kdump ，没有的话可以通过以下命令安装。

.. code-block:: bash

   yum install kexec-tools

修改内核启动参数添加 kdump 配置。

.. code-block:: ini

   # 修改 /etc/default/grub 中的内核启动参数，添加下面 crashkernel 参数
   GRUB_CMDLINE_LINUX="... crashkernel=auto"

重新生成 grub2 配置：

.. code-block:: bash

   grub2-mkconfig -o /boot/grub2/grub.cfg
   reboot

重启确认配置是否成功（成功后内核参数会多出上面新加的 crashkernel 参数）。

.. code-block:: console

   # cat /proc/cmdline
   BOOT_IMAGE=/boot/vmlinuz-4.19.113-88.8bs.el7.x86_64 ... crashkernel=auto ...

一个真实的崩溃现场
------------------

启用了 kdump 之后，每次内核崩溃，kdump 会在 ``/var/crash`` 下创建一个新的目录用来保存崩溃的现场信息，每个现场一般两个文件，一个 core 文件 ``vmcore`` ，一个崩溃时的 dmesg 文件。

.. code-block:: console

   # ll /var/crash/127.0.0.1-2023-12-20-10\:51\:07/
   total 160112
   -rw------- 1 root root 81906871 Dec 20 10:51 vmcore
   -rw-r--r-- 1 root root   137943 Dec 20 10:51 vmcore-dmesg.txt

首先查看 dmesg 文件，一般崩溃通过 ``dmesg`` 就可以定位。

.. code-block:: console

   $ cat /var/crash/127.0.0.1-2023-12-20-10\:51\:07/vmcore-dmesg.txt
   ...
   [ 1823.251269] RIP: 0010:iptunnel_xmit+0x17d/0x1c0
   [ 1823.253371] Code: ea 4c 89 e7 e8 d4 12 fb ff 48 85 ed 74 25 83 e0 fd 75 31 83 fb 00 7e 2a 48 8b 85 f0 04 00 00 65 48 03 05 ae 63 77 46 48 63 db <48> 83 40 10 01 48 01 58 18 48 83 c4 20 5b 5d 41 5c 41 5d 41 5e 41
   ...
   [ 1823.280234] Call Trace:
   [ 1823.281826]  <IRQ>
   [ 1823.283814]  send4+0xf2/0x1b0 [XxxWan]
   [ 1823.285593]  hfunc_out6+0x2f7/0x510 [XxxWan]
   [ 1823.289267]  ? ipt_do_table+0x351/0x680
   [ 1823.291741]  nf_hook_slow+0x3d/0xb0
   [ 1823.293875]  ip6_xmit+0x332/0x5e0
   [ 1823.295120]  ? neigh_key_eq128+0x30/0x30
   [ 1823.296623]  ? inet6_csk_route_socket+0x158/0x250
   [ 1823.298286]  ? __kmalloc_node_track_caller+0x5d/0x280
   [ 1823.299848]  inet6_csk_xmit+0x91/0xe0
   [ 1823.301455]  __tcp_transmit_skb+0x536/0x9f0
   ...
   [ 1823.367165]  </IRQ>
   ...

能从 dmesg 中获取到的有用信息：

1. ``RIP`` 是程序指令指针（Instruction Pointer Relative），指向下一条即将被执行的指令，在上面 dmesg 中，RIP 指向 ``iptunnel_xmit`` 函数的 0x17d 偏移处。
2. ``Code`` 行是内核崩溃时正在执行前后的指令 dump，其中 ``<48>`` 为当前 RIP 指向的指令处。
3. 最后 ``Call Trace`` 后面是内核崩溃时的函数调用栈，从调用栈可以看出内核是崩溃在了 ``XxxWan`` 模块的 ``send4`` 函数中，调用栈缺少 ``send4`` 函数到 ``iptunnel_xmit`` 的调用过程，并不完全。

反编译 vmlinux 获取崩溃的代码行
-------------------------------

系统日常启动加载的内核镜像（也就是内核的可执行文件）位于 ``/boot/`` 目录下，比如 ``/boot/vmlinuz-4.19.113-88.8bs.el7.x86_64``  ，这个内核镜像是去除了调试信息并压缩了的。各种内核调试工具需要用到是未压缩的原始
vmlinux 文件，这个文件一般在内核的 ``debuginfo`` 包中，安装。

对比可以看出未压缩的 vmlinux 镜像要比压缩后的 vmlinuz 镜像大两个数量级。

.. code-block:: console

   # ll -h /boot/vmlinuz-4.19.113-88.8bs.el7.x86_64
   -rwxr-xr-x 1 root root 8.4M Nov  4  2022 /boot/vmlinuz-4.19.113-88.8bs.el7.x86_64
   # ll -h /usr/lib/debug/lib/modules/$(uname -r)/vmlinux
   -rw-r--r-- 1 root root 495M Dec 22 14:59 /usr/lib/debug/lib/modules/4.19.113-88.8bs.el7.x86_64/vmlinux

有了 vmlinux，就可以通过 ``objdump -d`` 反编译内核，根据前面 dmesg 信息，内核崩溃点在 ``iptunnel_xmit`` 函数中，所以先获取 ``iptunnel_xmit`` 的起始地址（ ``objdump``
不支持直接反编译某一个函数），然后从这个起始地址开始反编译内核并打印出汇编代码对应的 c 代码行号。

.. code-block:: console

   $ objdump -d /usr/lib/debug/lib/modules/$(uname -r)/vmlinux | grep iptunnel_xmit
   ffffffff81898c00 <iptunnel_xmit>:
   ...
   $ objdump -d --start-address=0xffffffff81898c00 --line-numbers  /usr/lib/debug/lib/modules/$(uname -r)/vmlinux
   /usr/lib/debug/lib/modules/4.19.113-88.8bs.el7.x86_64/vmlinux: file format elf64-x86-64
   Disassembly of section .text:

   ...
   ffffffff81898c00 <iptunnel_xmit>:
   iptunnel_xmit():
   ...
   /usr/src/debug/kernel-alt-4.19.113/linux-4.19.113-88.8bs.el7.x86_64/include/net/ip_tunnels.h:458
   ffffffff81898d6b:  48 8b 85 f0 04 00 00    mov    0x4f0(%rbp),%rax
   ffffffff81898d72:  65 48 03 05 ae 63 77    add    %gs:0x7e7763ae(%rip),%rax        # f128 <this_cpu_off>
   ffffffff81898d79:  7e
   /usr/src/debug/kernel-alt-4.19.113/linux-4.19.113-88.8bs.el7.x86_64/include/net/ip_tunnels.h:461
   ffffffff81898d7a:  48 63 db                movslq %ebx,%rbx
   /usr/src/debug/kernel-alt-4.19.113/linux-4.19.113-88.8bs.el7.x86_64/include/net/ip_tunnels.h:462
   ffffffff81898d7d:  48 83 40 10 01          addq   $0x1,0x10(%rax)
   👆 RIP
   ...

``iptunnel_xmit`` 函数 0x17d 偏移处为地址 ``ffffffff81898d7d`` 。

.. code-block:: python

   >>> hex(0xffffffff81898c00+0x17d)
   0xffffffff81898d7dL

结合反编译内核得到的信息，可以获取到正在执行的代码位于 ``ip_tunnels.h`` 文件的 461 行。对应的 c 代码如下：

.. code-block:: c

   // ip_tunnels.h
   455 static inline void iptunnel_xmit_stats(struct net_device *dev, int pkt_len)
   456 {
   457   if (pkt_len > 0) {
   458 	  struct pcpu_sw_netstats *tstats = get_cpu_ptr(dev->tstats);
   459
   460     u64_stats_update_begin(&tstats->syncp);
   461     tstats->tx_bytes += pkt_len;
   ...
   475 }

自此分析结束，后面就是结合内核以及 ``XxxWan`` 的代码来看为什么这个地方会崩溃。

如果问题更复杂，还可以使用 ``crash`` 工具（类似 gdb）来从 core 文件中获取更多现场信息。

.. code-block:: bash

   crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux /var/crash/.../vmcore

``crash`` 比较耗内存，在本次崩溃的小虚拟机上跑不起来报 ``crash: cannot allocate any more memory!`` 错误，以后有机会再说，详细可以参见： https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/7/html/kernel_administration_guide/kernel_crash_dump_guide#sect-crash-running-the-utility 。