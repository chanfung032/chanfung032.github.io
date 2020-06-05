容器——seccomp-bpf
#########################

BPF
------------

BPF 本来指的是 Berkeley Packet Filter，如其字面义，是用在网络包的过滤这个场景上的，最早应用在 tcpdump 上，tcpdump 会将过滤表达式转换成 BPF 字节码然后调用内核的接口让其执行这段字节码程序来过滤网络包。

.. code-block:: console

	# tcpdump -p -ni eth0 -d "ip and src 1.1.1.1"
	(000) ldh      [12]
	(001) jeq      #0x800           jt 2	jf 5
	(002) ld       [26]
	(003) jeq      #0x1010101       jt 4	jf 5
	(004) ret      #262144
	(005) ret      #0

这段程序的意思翻译过来如下：

- （000）加载 ethernet packet 第 12 个字节开始的 2 个字节（ethernet frame 的类型字段）。
- （001）检查加载的值是否为 0x800 （是否为 IP 包），是的话跳到 002 执行，否则 005。
- （002）加载 ethernet packat 第 26 个字节开始的 4 个字节（IP 包的原地址字段）。
- （003）检查加载的值是否为 0x1010101（IP 是否为 1.1.1.1），是的话跳到 004 执行，否则 005。
- （004）返回包匹配。
- （005）返回包不匹配。

上面打印出得是翻译过的给人看字节码，我们也可以打印出给机器读的字节码：

.. code-block:: console

	# tcpdump -p -ni eth0 -ddd "ip and src 1.1.1.1"
	6
	40 0 0 12
	21 0 3 2048
	32 0 0 26
	21 0 1 16843009
	6 0 0 262144
	6 0 0 0


tcpdump 然后使用类似下面程序的方式将 bpf 程序提交给内核去执行，后面内核只会将匹配 bpf 程序的包发送给 tcpdump。

.. code-block:: c

    #include <sys/socket.h>
    #include <sys/types.h>
    #include <arpa/inet.h>
    #include <linux/if_ether.h>

    /* BPF 字节码结构体
       struct sock_filter {
         __u16	code; 字节码
         __u8	jt;   成功跳转
         __u8	jf;   失败跳转
         __u32	k;    根据字节码不同意义不一样
       };
    */
    struct sock_filter code[] = {
      {40, 0, 0, 12},
      {21, 0, 3, 2048},
      {32, 0, 0, 26},
      {21, 0, 1, 16843009},
      {6,  0, 0, 262144},
      {6,  0, 0, 0},
    };

    /* BPF 程序元信息
       struct sock_fprog {
         unsigned short             len;
         struct sock_filter __user *filter;
       };
    */
    struct sock_fprog bpf = {
      .len = ARRAY_SIZE(code),
      .filter = code,
    };

    sock = socket(PF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    ret = setsockopt(sock, SOL_SOCKET, SO_ATTACH_FILTER, &bpf, sizeof(bpf));

seccomp-bpf
---------------------

目前 bpf 在 Linux 上已经应用在方方面面各种场景下， seccomp-bpf 就是 bpf 在 seccomp 上的应用。容器使用 seccomp-bpf + capability 来限制一个容器进程可以调用的系统调用。

.. code-block:: c

    #include <errno.h>
    #include <linux/audit.h>
    #include <linux/bpf.h>
    #include <linux/filter.h>
    #include <linux/seccomp.h>
    #include <linux/unistd.h>
    #include <stddef.h>
    #include <stdio.h>
    #include <sys/prctl.h>
    #include <unistd.h>

    int main() {
      printf("hey there!\n");

      struct sock_filter filter[] = {
          BPF_STMT(BPF_LD + BPF_W + BPF_ABS, (offsetof(struct seccomp_data, arch))),
          BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, AUDIT_ARCH_X86_64, 0, 3),
          BPF_STMT(BPF_LD + BPF_W + BPF_ABS, (offsetof(struct seccomp_data, nr))),
          BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, __NR_write, 0, 1),
          BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
          BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ALLOW),
      };
      struct sock_fprog prog = {
          .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
          .filter = filter,
      };
      // 让 seccomp-bpf 程序生效后即使后面程序执行了 execve 也能继续生效
      // https://www.kernel.org/doc/Documentation/prctl/no_new_privs.txt
      if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
        perror("prctl(NO_NEW_PRIVS)");
        return 1;
      }
      // 设置 seccomp-bpf
      if (prctl(PR_SET_SECCOMP, 2, &prog)) {
        perror("prctl(PR_SET_SECCOMP)");
        return 1;
      }

      printf("it will not definitely print this here\n");
      return 0;
    }

上面的 bpf 程序使用各种宏来写的，翻译成 human readable 的格式就是： ::

	(001) ldh seccomp_data.arch
	(002) jeq AUDIT_ARCH_X86_64 jt 3 jf 6
	(003) ldh seccomp_data.nr
	(004) jeq __NR_write        jt 5 jf 6
	(005) ret SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)
	(006) ret SECCOMP_RET_ALLOW

运行程序只会打印出第一个 ``hey there!`` ，最后 printf 的 ``it will not ...`` 打印不出来，因为 printf 最后调用系统调用 write 的时候会返回错误 EPERM。strace 可以看到结果如下： ::


	write(1, "it will not definitely print thi"..., 39) = -1 EPERM (Operation not permitted)

参考：

- https://blog.cloudflare.com/bpf-the-forgotten-bytecode/
- https://www.kernel.org/doc/Documentation/networking/filter.txt
- https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/include/uapi/linux/filter.h?h=v3.16.84

