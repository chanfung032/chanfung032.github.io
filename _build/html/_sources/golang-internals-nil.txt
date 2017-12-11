Go 语言实现——nil
==================

按照 Go 语言规范，任何类型在未初始化时都对应一个零值，boolean 是 false，int 是 0，而 pointer, function, interface, slice, channel, map 的零值是 nil [1]_ 。

我们用下面这段简单的程序来看下各种类型的 nil 到底是什么。

.. code-block:: go

    package main

    func main() {
        var p *int
        println(p)

        var f func()
        println(f)

        var i interface{}
        println(i)

        var s []int
        println(s)

        var m map[int]int
        println(m)

        var c chan int
        println(c)
    }

运行的输出结果（// 后是注释）： ::

    0x0         // pointer
    0x0         // function
    (0x0,0x0)   // interface
    [0/0]0x0    // slice
    0x0         // map
    0x0         // channel

反编译可以看到 print 语句被翻译为了以下调用： ::

	test.go:9	0x782	e800000000		CALL 0x787		[1:5]R_CALL:runtime.printpointer
    ...
	test.go:12	0x7a8	e800000000		CALL 0x7ad		[1:5]R_CALL:runtime.printpointer
	...
	test.go:15	0x7e1	e800000000		CALL 0x7e6		[1:5]R_CALL:runtime.printeface
	...
	test.go:18	0x82d	e800000000		CALL 0x832		[1:5]R_CALL:runtime.printslice
    ...
	test.go:21	0x853	e800000000		CALL 0x858		[1:5]R_CALL:runtime.printpointer
    ...
	test.go:24	0x879	e800000000		CALL 0x87e		[1:5]R_CALL:runtime.printpointer

打印的实现代码在 src/runtime/print.go 中 [2]_ 。

综上可以得出：

- pointer, function, map, channel 的零值都是空指针（0）。
- slice, interface 是各自的结构体中所有的值都是 0 。

最后，我们来看看 Go 官方文档 FAQ 里提到的一个问题 [3]_ ：

.. code-block:: go

    type MyError struct{}

    func (e *MyError) Error() string {
        return ""
    }

    func returnsError() error {
        var p *MyError = nil
        return p
    }

    func main() {
        println(returnsError() == nil)
    }

这段代码的输出为 false ，因为 returnsError 的返回值类型 error 是一个 interface ，所以它返回的是 （\*MyError, nil) ，也就是说返回的 interface 的值是 nil，但是其本身并不是 nil 。

.. [1] https://golang.org/ref/spec#The_zero_value
.. [2] https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/print.go#L231
.. [3] https://golang.org/doc/faq#nil_error