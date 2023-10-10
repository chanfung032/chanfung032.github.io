Go 语言实现——启动过程
========================

.. code-block:: console

    $ gdb test
    ...
    (gdb) info files
    Symbols from "/root/test".
    Local exec file:
        `/root/test', file type elf64-x86-64.
        Entry point: 0x44bb80
        ...
    (gdb) b *0x44bb80

用 gdb 跟踪一下 Go 程序启动阶段的执行，可以得到其执行路径大致如下： ::

    ➜ _rt0_amd64_linux () at src/runtime/rt0_linux_amd64.s:8
      ➜ main () at src/runtime/rt0_linux_amd64.s:73
        ➜ runtime.rt0_go () at src/runtime/asm_amd64.s:12

前面两个函数做的事情比较简单，就是保存一下（argc，argv）到（SI，DI）寄存器，然后跳转到 *runtime·rt0_go* 函数执行。

.. code-block:: asm

    TEXT _rt0_amd64_linux(SB),NOSPLIT,$-8
        LEAQ  8(SP), SI // argv
        MOVQ  0(SP), DI // argc
        MOVQ  $main(SB), AX
        JMP   AX
    TEXT main(SB),NOSPLIT,$-8
        MOVQ  $runtime·rt0_go(SB), AX
        JMP   AX

*runtime·rt0_go* 是一个比较复杂的函数，这里会完成所有的初始化工作并开始程序的执行，它的逻辑大致如下：

1. 初始化 root goroutine 的运行环境，为执行 Go 代码做好准备（类似于操作系统一开始会用汇编初始化好 C 运行环境然后跳到 C 代码执行）。
2. 获取 cpuinfo ，初始化相关的一些 runtime 标志变量，比如： *runtime·support_sse2* 。
3. 调用 args() 获取一些跟内核相关的信息，比如内核的 page size 等。这些数据存在 argc, argv 之后一段叫做 `auxv <https://lwn.net/Articles/519085/>`_ 的数据里。
4. 调用 osinit() ，初始化 ncpu 。
5. 调用 schedinit() 初始化各种子系统。
    - 栈、内存管理初始化
    - 调度器初始化
    - 将命令行参数和环境变量保存到 slice 中，这样 os.Args() 和 os.Environ() 只要返回这个 slice 就行了
    - gc 初始化
    - ...
6. 创建一个新的 goroutine，其执行函数为 *runtime·main* ，这个函数最终会调用 *main·main* 也就是用户代码的入口函数。
7. 调用 *runtime·mstart()* 让线程开始调度执行 goroutine 。

从第 1 步之后的各种初始化基本都是用 Go 写的，所以系统一开始得先准备一个 root goroutine 的执行环境出来用来执行这部分初始化代码。这个主要涉及 3 个数据：

- g0，类型为 g，root goroutine 的关联数据，主要是需要初始化执行栈的相关变量。
- m0，类型为 m，主线程的关联数据，主要 m0.tls ，线程的 TLS 数据。
- TLS，go 代码中很多地方需要获取当前运行的 goroutine 对应的 g 数据，这个指针存在线程的 TLS 里的。

*runtime·rt0_go* 的代码使用汇编写的，下面是其大致的伪代码：

https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/asm_amd64.s#L10

.. code-block:: go

    // proc.go
    var (
        m0           m
        g0           g
    )

    // runtime2.go
    type g struct {
        // goroutine 的栈空间内存范围: [stack.lo, stack.hi).
        stack       stack
        // 栈空间一开始分配是比较小的，SP 指针小于 stackguard0 后说明栈空间不够，要 realloc 了。
        stackguard0 uintptr
        stackguard1 uintptr
        ...
    }

    type m struct

    // 下面是 asm_amd64.s 中 runtime·rt0_go 的伪代码
    // 初始化 root goroutine 执行栈的相关变量。
    g0.stack.hi = (SP)
    g0.stack.lo = (-64*1024+104)(SP)
    g0.stackguard0 = g0.stack.lo
    g0.stackguard1 = g0.stack.lo

    // 设置当前线程的 TLS 指向 m0.tls
    arch_prctl(ARCH_SET_FS, m0.tls)

    // 让 m0.tls 指向 g0 也就是让当前线程的 TLS 指向 g0
    // go 编译出的代码中很多地方会通过类似下面的代码来获取当前执行的 goroutine 的相关数据
    //   get_tls(CX)
    //   MOVQ  g(CX), AX     // Move g into AX.
    //   MOVQ  g_m(AX), BX   // Move g.m into BX.
    // https://golang.org/doc/asm#amd64
    m0.tls = &g0

    // 继续初始化 m0 和 g0 这两个变量
    m0.g0 = &g0
    g0.m = &m0

    // 一些环境检查
    runtime·check()
    // 从 auxv 数据里读取一些有用的信息
    runtime·args()

    // 初始化 ncpu
    runtime·osinit()
    // 各种子系统的初始化
    runtime·schedinit()

    // 创建一个新的 goroutine ，执行函数为 runtime.main
    runtime.newproc(0, runtime.main)

    // kick start the world
    runtime·mstart()

*runtime·schedinit* 的缩略代码：

https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/proc.go#L468

.. code-block:: go

    func schedinit() {
        // 获取 root goroutine 的 g 指针 也就是 &g0
        _g_ := getg()

        // 最大线程数为 10000
        sched.maxmcount = 10000

        tracebackinit()
        moduledataverify()
        // 栈和内存管理的初始化
        stackinit()
        mallocinit()
        // Go 中 m 指的就是线程，这里也就是初始化调度器
        mcommoninit(_g_.m)
        // 初始化 hash 算法，go 里 map 使用 hashmap 实现的，所以这行代码之前是不能用 map 的。
        alginit()
        modulesinit()
        typelinksinit()
        itabsinit()

        msigsave(_g_.m)
        initSigmask = _g_.m.sigmask

        // 将命令行参数和环境变量保存到 slice 中，这样 os.Args() 和 os.Environ() 只要返回这个 slice 就行了
        goargs()
        goenvs()
        parsedebugvars()
        // 初始化 gc
        gcinit()

        sched.lastpoll = uint64(nanotime())
        // 设置并发数，所以代码中不用再写 runtime.GOMAXPROCS(n) 了，因为默认已经初始化好了
        procs := ncpu
        if n, ok := atoi32(gogetenv("GOMAXPROCS")); ok && n > 0 {
            procs = n
        }
        if procs > _MaxGomaxprocs {
            procs = _MaxGomaxprocs
        }
        if procresize(procs) != nil {
            throw("unknown runnable goroutine during bootstrap")
        }
    }

*runtime·main* 函数的缩略代码：

https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/proc.go#L109

.. code-block:: go

    func main() {
        // 创建出一个单独的物理线程来执行 sysmon ，这个函数和调度相关
        systemstack(func() {
            newm(sysmon, nil)
        })

        // 执行 runtime 包里的所有 init 函数
        runtime_init()

        // 开启 gc
        gcenable()

        // 执行所有用户包（包括标准库）的init函数
        fn := main_init
        fn()

        // 执行 main.main() 函数，也就是用户代码的入口函数
        fn = main_main
        fn()

        exit(0)
    }

Go 的初始化过程是个非常复杂的过程，这里我们只是简单的理了一下其大致的流程，详细的分析在后续的各个子系统的分析中再说。

参考：

- https://golang.org/doc/gdb
- https://blog.altoros.com/golang-internals-part-5-runtime-bootstrap-process.html
