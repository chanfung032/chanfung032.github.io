有符号类型、负数与类型转换
=============================

问题
----------

最近帮同事调试代码遇到的一个问题，这个问题可以简化为下面这段代码：

.. code-block:: c

    #include <stdio.h>

    int main() {
        char c = 0xa9;
        unsigned int u = c;
        printf("%x\n", u);
    }

这段代码会输出什么？在 x86_64 机器上使用 gcc 编译然后执行的结果是 ``ffffffa9``。emm....，是不是和想的有点不一样，不是 ``a9``，问题在哪？

反编译可以看到上面赋值语句被翻译成了如下的汇编代码：

.. code-block:: objdump

    400535: c6 45 ff a9          movb   $0xa9,-0x1(%rbp)
    将一个字节的立即值 0xa9 压入栈中

    400539: 0f be 45 ff          movsbl -0x1(%rbp),%eax
    movsbl 指令负责拷贝一个字节为 4 个字节，并用这个字节的最高位填充其它 3 个字节，这种扩展方式叫“符号扩展”

如果将 ``char c = 0xa9`` 改成 ``unsigned char`` 再重新编译，这个赋值语句就会变成了下面这段汇编代码：

.. code-block:: objdump

    400535: c6 45 ff a9          movb   $0xa9,-0x1(%rbp)

    400539: 0f b6 45 ff          movzbl -0x1(%rbp),%eax
    movzbl 指令负责拷贝一个字节为 4 个字节，并使用 0 填充其它字节，也叫“零扩展”

所以问题就出在了：

1. 编译器将 ``char`` 等同于了 ``signed char``，上面代码中的 ``char c = 0xa9`` 写成 ``char c = -87`` 会更清晰点，也就是一个负数。
2. 将 ``signed char`` 做（隐式）类型转换到 ``unsigned int`` 时，转换的方法是什么。

负数表示法
------------------

以 ``int8_t`` 为例，87 的编码为： ::

    01010111

来看 -87 的几种表示方法：  ::

    11010111 原码，第一位符号位，其余位和正 87 一样
    10101000 反码，就是将 87 的所有二进制位进行取反
    10101001 补码，补码为反码加 1

目前普遍使用的是 **补码** 表示法。使用补码运算方便，负数和正数可以直接运算，以 ``87 + (-87)`` 为例： ::

      反码           补码
      01010111      01010111
    + 10101000    + 10101000
                  +        1
    ----------    ----------
      11111111      00000000

补码直接运算的结果就是实际的结果。

另外反码还有一个问题就是 ``11111111``，表示 ``-0``，和 ``00000000`` 表示的 ``+0`` 一起，出现了两个 ``0``，浪费了，反码只能表示 ``（-128, 127]`` 区间的数值，而补码可以表示 ``[-128, 127]`` 区间的数值。

类型转换
------------------

C99: https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1256.pdf

    whether a "plain" char is treated as signed is implementation-defined

C99 中并没有定义 ``char`` 到底是有符号还是无符号的，留给编译器自己定，显然 gcc 中 ``char`` 是有符号的，也就是等价于 ``signed char``。

    if the new type is unsigned, the value is converted by repeatedly adding or
    subtracting one more than the maximum value that can be represented in the new type
    until the value is in the range of the new type

将 ``signed char`` 转换为 ``unsigned int`` 的规则为加上或减去 ``UINT_MAX + 1``。对于 32 bit int。

    >>> hex(-87 + 0xffffffff+1)
    '0xffffffa9'

这个规则转换为汇编代码就是上面的 ``movsbl`` 指令，也就是符号扩展。如果把上面的隐式类型转换用显式类型转换写出来就是：

.. code-block:: c

    unsigned int u = (unsigned int)((signed int)c);

这样理解上面的程序错误就更直观了。

如何让 strace 打印出变量的原始值
-------------------------------------

可以使用 strace 的 ``-X verbose`` 选项，就可以既打印出原始值，也打印出翻译后的结果。有时候原始值能更直观的看出问题所在。

比如下面两个 sendto 发送的内容，第一个是正常的结果，第二个是异常的结果，看里面的 ``type`` 参数，直接看也就是奇怪为什么第二个 sendto 的 ``type`` 参数没有翻译成对应的类型名称。

.. code-block:: console

    [host1]# strace -esendto <command>
    sendto(3, {{len=20, type=genl_hiwan, flags=NLM_F_REQUEST, seq=996, pid=0}, "\x06\x01\x00\x00"}, 20, 0, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}, 12) = 20
    [host2]# strace -esendto <command>
    sendto(3, {{len=20, type=0xffa9, flags=NLM_F_REQUEST, seq=996, pid=0}, "\x06\x01\x00\x00"}, 20, 0, {sa_family=0x10, nl_pid=0, nl_groups=00000000}, 12) = 20

使用 ``-X verbose`` 参数就能一目了然的看出问题所在，因为这两个传的值不一样。

.. code-block:: console

    [host1]# strace -Xverbose -esendto <command>
    sendto(3, {{len=20, type=0x31 /* genl_hiwan */, flags=NLM_F_REQUEST, seq=996, pid=0}, "\x06\x01\x00\x00"}, 20, 0, {sa_family=0x10 /* AF_NETLINK */, nl_pid=0, nl_groups=00000000}, 12) = 20

这个传的 ``type`` 在两个机器上稍微有点不一样，host2 上本来应该传的是 ``0xa9``，但是和本文前面描述的问题一样，因为类型转换的问题，传成了 ``0xffa9``，导致了程序错误。