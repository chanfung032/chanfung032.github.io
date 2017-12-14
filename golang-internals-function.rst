Go 语言实现——函数
==================

调用规范
---------

代码： 

.. code-block:: go

    func foo(x, y int) int {
        return x - y
    }

    func main() {
        print(foo(1, 2))
    }

编译后的汇编代码：

.. code-block:: console

    $ go compile -l -S test.go
    "".foo STEXT nosplit size=19 args=0x18 locals=0x0
        // foo 函数，$0-24 表示这个函数的stack frame的大小为0，参数的长度为24
        0x0000 00000 (test.go:3)	TEXT	"".foo(SB), NOSPLIT, $0-24
        ...
        // 将x, y读取到AX, CX寄存器中，相减, name+8(SP)表示：变量名+偏移(寄存器)
        0x0000 00000 (test.go:3)	MOVQ	"".x+8(SP), AX
        0x0005 00005 (test.go:3)	MOVQ	"".y+16(SP), CX
        0x000a 00010 (test.go:4)	SUBQ	CX, AX
        0x000d 00013 (test.go:4)	MOVQ	AX, "".~r2+24(SP)
        0x0012 00018 (test.go:4)	RET

    "".main STEXT size=102 args=0x0 locals=0x28
        0x0000 00000 (test.go:7)	TEXT	"".main(SB), $40-0
        ...
        // 压入参数，调用函数 foo
        0x001d 00029 (test.go:8)	MOVQ	$1, (SP)
        0x0025 00037 (test.go:8)	MOVQ	$2, 8(SP)
        0x002e 00046 (test.go:8)	CALL	"".foo(SB)
        // 16(SP)中是返回值
        0x0033 00051 (test.go:8)	MOVQ	16(SP), AX
        0x0038 00056 (test.go:8)	MOVQ	AX, ""..autotmp_1+24(SP)
        ...

在 *main* 函数中时，栈是下面这样的（栈是从高地址往低地址增长的）： ::

    返回值
    参数2
    参数1  <-SP

执行 CALL *foo* 函数指令进入 *foo* 函数后，栈会变成下面这样： ::

    返回值
    参数2
    参数1
    返回地址（PC） <-SP

从上面可以看出：

- 函数调用的参数通过栈来传递。
- 函数的返回值也是通过栈来返回，不是通过寄存器，因为 Go 支持多返回值。
- *foo* 函数并没有保护恢复寄存器的代码，所以寄存器应该是 caller 保护而不是 callee 保护的。
- 栈基本和 C 一样，只是 convention 稍微不同（那么多个 goroutine 的话，它们各自的栈在内存中又是怎样布局的呢？）。

Defer
---------

From: https://blog.golang.org/defer-panic-and-recover

    A deferred function's arguments are evaluated when the defer statement is evaluated.

    defer 的函数的参数是在 defer 的地方计算的。

    Deferred function calls are executed in Last In First Out order after the surrounding function returns.

    defer 的函数在外围函数返回之前执行，先 defer 的后执行。

    Deferred functions may read and assign to the returning function's named return values.

    defer 的函数可以修改 *named return values* 的值。

上面这个 *返回之前执行* 是这样执行的：

1. 先将 return 的值赋给返回变量。
2. 执行 defer 的函数（ **这里是可以修改返回变量的值的!!!** ）。
3. return 返回。

比如下面这段代码，根据上面的过程可以得出输出为 11 而不是 10：

.. code-block:: go

    func foo() (r int) {
        defer func() {
            r = r + 1
        }()
        return 10
    }

下面为这段代码的汇编代码： ::

    // 初始化返回值为 0
    0x001d 00029 (test.go:3)	MOVQ	$0, "".~r0+32(FP)
    // 调用 runtime.deferproc 保存函数及其参数
    // func deferproc(siz int32, fn *funcval)
    // https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/panic.go#L305
    0x0026 00038 (test.go:6)	MOVL	$0, (SP)
    0x002d 00045 (test.go:6)	LEAQ	"".foo.func1·f(SB), AX
    0x0034 00052 (test.go:6)	MOVQ	AX, 8(SP)
    0x0039 00057 (test.go:6)	CALL	runtime.deferproc(SB)
    0x003e 00062 (test.go:6)	TESTL	AX, AX
    0x0040 00064 (test.go:6)	JNE	91
    // 将 10 赋给返回值
    0x0042 00066 (test.go:7)	MOVQ	$10, "".~r0+32(FP)
    0x004b 00075 (test.go:7)	XCHGL	AX, AX
    // 调用 runtime.deferreturn 执行 defer 的函数
    // https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/panic.go#L291
    0x004c 00076 (test.go:7)	CALL	runtime.deferreturn(SB)
    ...
    // 返回
    0x005a 00090 (test.go:7)	RET

Eacape analysis
------------------

.. code-block:: go

    func foo() *int {
        i := 1
        return &i
    }

类似上面这种写法在 C 中是错误的，因为变量 *i* 是分配在栈上的， 后面的函数调用会覆盖 *i* 。那么 Go 是怎么做到的呢？

答案是 Go 是会通过 `Escape analysis <https://en.wikipedia.org/wiki/Escape_analysis>`_ 自动将其分配在堆上。

.. code-block:: console

    $ go tool compile -m -l -S test.go
    test.go:5: &i escapes to heap
    test.go:4: moved to heap: i
    "".foo t=1 size=79 args=0x8 locals=0x18
        0x0000 00000 (test.go:3)	TEXT	"".foo(SB), $24-8
        ...
        // 创建一个新的 int 对象
        0x001d 00029 (test.go:4)	LEAQ	type.int(SB), AX
        0x0024 00036 (test.go:4)	MOVQ	AX, (SP)
        0x0028 00040 (test.go:4)	CALL	runtime.newobject(SB)
        0x002d 00045 (test.go:4)	MOVQ	8(SP), AX
        // 将 1 赋给 int 对象
        0x0032 00050 (test.go:4)	MOVQ	$1, (AX)
        // 将 int 对象地址赋给返回变量
        0x0039 00057 (test.go:5)	MOVQ	AX, "".~r0+32(FP)
        ...
        0x0047 00071 (test.go:5)	RET
        ...

闭包
-----------

闭包（closure） = 函数（function） + 其外围的环境（environment）

Go 中是通过结构体来实现闭包的。比如下面 foo 返回的匿名函数。

.. code-block:: go

    func foo(x int) func() int {
        return func() int {
            return x
        }
    }

实际 Go 在返回的时候返回的是如下的结构体：

.. code-block:: go

    type Closure struct {
        F uintptr
        x int
    }

详细的汇编代码分析如下： ::

    "".foo t=1 size=91 args=0x10 locals=0x18
        0x0000 00000 (test.go:3)	TEXT	"".foo(SB), $24-16
        ...
        // 创建一个新的 Closure 结构体用来保存闭包。
        // func newobject(typ *_type) unsafe.Pointer
        // https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/malloc.go#L839
        0x001d 00029 (test.go:4)	LEAQ	type.struct { F uintptr; "".x int }(SB), AX
        0x0024 00036 (test.go:4)	MOVQ	AX, (SP)
        0x0028 00040 (test.go:4)	CALL	runtime.newobject(SB)
        0x002d 00045 (test.go:4)	MOVQ	8(SP), AX
        // 将返回的函数地址赋给 Closure 结构体的第一个字段 F
        0x0032 00050 (test.go:4)	LEAQ	"".foo.func1(SB), CX
        0x0039 00057 (test.go:4)	MOVQ	CX, (AX)
        // 将变量 x 赋值给 Closure 结构体的第二个字段 x
        0x003c 00060 (test.go:4)	MOVQ	"".x+32(FP), CX
        0x0041 00065 (test.go:4)	MOVQ	CX, 8(AX)
        // 将 Closure 结构体的地址放入返回变量中
        0x0045 00069 (test.go:6)	MOVQ	AX, "".~r1+40(FP)
        ...
        0x0053 00083 (test.go:6)	RET

    "".main t=1 size=102 args=0x0 locals=0x20
        ...
        // 压入参数 3 并调用函数 foo ，返回值存在 8（SP） 
        0x001d 00029 (test.go:10)	MOVQ	$3, (SP)
        0x0025 00037 (test.go:10)	CALL	"".foo(SB)
        // 将返回值也就是 Closure 结构体的指针放入到 DX 寄存器
        0x002a 00042 (test.go:10)	MOVQ	8(SP), DX
        // 取 Closure 结构体的第一个字段也就是函数指针 F 并放入到 AX 寄存器
        0x002f 00047 (test.go:10)	MOVQ	(DX), AX
        // 调用函数 F ，返回值存入 (SP)
        0x0032 00050 (test.go:10)	CALL	AX
        0x0034 00052 (test.go:10)	MOVQ	(SP), AX
        0x0038 00056 (test.go:10)	MOVQ	AX, ""..autotmp_3+16(SP)
        ...

    "".foo.func1 t=1 size=10 args=0x8 locals=0x0
        0x0000 00000 (test.go:4)	TEXT	"".foo.func1(SB), $0-8
        ...
        // DX 是指向 Closure 结构体的指针，8(DX) 就是第一个参数。
        0x0000 00000 (test.go:4)	MOVQ	8(DX), AX
        0x0004 00004 (test.go:5)	MOVQ	AX, "".~r0+8(FP)
        0x0009 00009 (test.go:5)	RET

参考: https://tiancaiamao.gitbooks.io/go-internals/content/zh/03.0.html