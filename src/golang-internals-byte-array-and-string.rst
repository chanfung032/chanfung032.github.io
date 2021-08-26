Go 语言实现——[]byte 和 string
======================================

.. _byte string conversion:

[]byte 和 string 互相类型转换复制底层数据吗？
------------------------------------------------

.. code-block:: go

    []byte("helloworld")
    string([]byte{0x1, 0x2})

复制，或者说大部分情况下复制。

虽然 []byte 和 string 两个类型的底层结构差不多，string 的结构和 []byte 的前两个字段一致，但是大部分情况下类型转换的时候 go 还是会新建一个对象，然后将数据复制过去，而不是直接把 data 指针和 len 长度复制过去。因为 string 是 immutable 类型，[]byte 是 mutable 的。

.. code-block:: go

    // src/runtime/slice.go
    type slice struct {
        data uintptr
        len int
        cap int
    }

    // src/runtime/string.go
    type stringStruct struct {
	    str unsafe.Pointer
	    len int
    }

以下面这段代码为例：

.. code-block:: go

    // 保存到 t.go 然后 go tool compile -S t.go
    b := []byte(s)

打印出这段代码编译出的汇编代码：

.. code-block:: bash

    # 将临时变量 autotmp_2 的地址押入栈作为 runtime.stringtoslicebyte 的第一个参数
    0x0021 00033 (t.go:6)	LEAQ	""..autotmp_2+64(SP), AX
    0x0026 00038 (t.go:6)	MOVQ	AX, (SP)
    # 加载字符串的地址 AX 寄存器中
    0x002a 00042 (t.go:6)	LEAQ	go.string."hello world"(SB), AX
    # 在栈中直接构建 runtime.stringtoslicebyte 第二个参数 string 结构体
    # 首先将前面字符串的地址 AX 赋值给 stringStruct.str
    0x0031 00049 (t.go:6)	MOVQ	AX, 8(SP)
    # 将长度信息赋值给 stringStruct.len
    0x0036 00054 (t.go:6)	MOVQ	$11, 16(SP)
    0x003f 00063 (t.go:6)	PCDATA	$1, $0
    0x003f 00063 (t.go:6)	NOP
    # 调用 runtime.stringtoslicebyte 函数
    0x0040 00064 (t.go:6)	CALL	runtime.stringtoslicebyte(SB)

下面是 runtime.stringtoslicebyte 的实现代码，该函数接受两个参数，第二个是要复制的字符串。如果转换后的变量没有逃逸的话，那么 go 会直接在栈上给对象分配空间并复制，第一个参数就是栈上的地址，如果逃逸了第一个参数就是 nil，runtime.stringtoslicebyte 会在堆上新建一个对象并复制。

.. code-block:: go

    func stringtoslicebyte(buf *tmpBuf, s string) []byte {
        var b []byte
        if buf != nil && len(s) <= len(buf) {
            *buf = tmpBuf{}
            b = buf[:len(s)]
        } else {
            b = rawbyteslice(len(s))
        }
        copy(b, s)
        return b
    }

    func rawbyteslice(size int) (b []byte) {
        cap := roundupsize(uintptr(size))
        p := mallocgc(cap, nil, false)
        if cap != uintptr(size) {
            memclrNoHeapPointers(add(p, uintptr(size)), cap-uintptr(size))
        }

        *(*slice)(unsafe.Pointer(&b)) = slice{p, size, int(cap)}
        return
    }

另外，也有不少情况编译器优化会不复制数据，直接指针指过去，[]byte 转 string 有两个方法，slicebytetostring 和 slicebytetostringtmp，其中 slicebytetostringtmp 就是不复制版本。

上层代码也可以使用不复制数据的类型转换：

.. code-block:: go

    import (
        "unsafe"
    )

    func ByteSliceToString(b []byte) string {
        return *(*string)(unsafe.Pointer(&b))
    }

参考&延伸：

- https://github.com/golang/go/blob/master/src/runtime/slice.go
- https://github.com/golang/go/blob/master/src/runtime/string.go
- https://github.com/golang/go/blob/release-branch.go1.17/src/cmd/compile/internal/walk/convert.go#L249
- https://golang.design/under-the-hood/zh-cn/part1basic/ch01basic/asm/
- https://syslog.ravelin.com/byte-vs-string-in-go-d645b67ca7ff
- https://github.com/golang/go/wiki/CompilerOptimizations#string-and-byte


fasthttp 中 []byte、string 的一些优化小技巧
---------------------------------------------

https://github.com/valyala/fasthttp#fasthttp-best-practices

复用 []byte
``````````````````

    Do not allocate objects and []byte buffers - just reuse them as much as possible. Fasthttp API design encourages this.

fasthttp 中的很多接口有一个额外的 ``dst`` 参数，这个参数就是给复用 []byte 用的。

.. code-block:: go

    func Get(dst []byte, url string) (statusCode int, body []byte, err error)

``fasthttp.Get`` 返回的 body 可以通过 dst 传给下一次调用重复使用，``fasthttp.Get`` 中执行 ``dst = dst[:0]`` 重置 buffer，然后复用这个 buffer。


使用 sync.Pool 缓存频繁申请释放的对象
``````````````````````````````````````

    sync.Pool is your best friend

sync.Pool 的实现说明参见：:doc:`golang-internals-sync-pool`

使用样例可以参见：https://github.com/valyala/fasthttp/search?q=sync.pool

避免 []byte 和 string 的类型转换
````````````````````````````````````

    Avoid conversion between []byte and string, since this may result in memory allocation+copy. Fasthttp API provides functions for both []byte and string - use these functions instead of converting manually between []byte and string. There are some exceptions - see this wiki page for more details

避免 []byte 和 string 之间的类型转换，因为大部分转换都需要重新分配内存再把数据拷贝过去。详见：:ref:`byte string conversion` 。

fasthttp 中底层一般都是使用 []byte 类型来存储 http 的数据，但有些接口也提供了 XxxString() 版本接受 string 参数，String 版本里是使用 ``append(b, s...)`` 这个方式来避免转换，直接将数据复制到底层 []byte 类型的 buffer 中的。

nil []byte 无需特殊对待
``````````````````````````````

[]byte 的零值 nil 不用特殊对待，可以和空 slice ``[]byte{}`` 一样的使用（nil 和 空 slice 只是指向底层数组的指针不一样，其它结构都是一样的，详见：:doc:`golang-internals-nil`）。

下面这些都是合法的：

.. code-block:: go

    var (
        // both buffers are uninitialized
        dst []byte
        src []byte
    )
    // 下面这些都是合法的
    dst = append(dst, src...)
    copy(dst, src)
    (string(src) == "")
    (len(src) == 0)
    src = src[:0]

    for i, ch := range src {
        doSomething(i, ch)
    }

    // 不需要像下面这样检查 []byte 是不是 nil，直接用就可以了
    //     srcLen := 0
    //     if src != nil {
    //         srcLen = len(src)
    //     }
    srcLen := len(src)

string 可以被 append 给 []byte
```````````````````````````````````````

.. code-block:: go

    var dst []byte
    dst = append(dst, "foobar"...)
