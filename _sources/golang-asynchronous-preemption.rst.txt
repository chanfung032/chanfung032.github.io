Go 语言实现——异步抢占调度
============================

Go 1.4 中添加了异步抢占调度：

    Goroutines are now asynchronously preemptible. As a result, loops without function calls no longer potentially deadlock the scheduler or significantly delay garbage collection. This is supported on all platforms except windows/arm, darwin/arm, js/wasm, and plan9/\*.

    https://golang.org/doc/go1.14#runtime

这个功能主要是解决 :doc:`golang-internals-goroutine` 切换一节中曾经说过的 *goroutine 如果一直不调用函数，那么它就不会被抢占* 问题。

顺着 :ref:`之前的解析 <golang-goroutine-schedule>` 往下看，diff 一下可以看到， ``preemptone`` 比之前的代码增加了下面的部分：

.. code-block:: diff

     func preemptone(_p_ *p) bool {
         mp := _p_.m.ptr()
         if mp == nil || mp == getg().m {
             return false
         }
         gp := mp.curg
         if gp == nil || gp == mp.g0 {
             return false
         }

         gp.preempt = true

         gp.stackguard0 = stackPreempt

    +    if preemptMSupported && debug.asyncpreemptoff == 0 {
    +        _p_.preempt = true
    +        preemptM(mp)
    +    }

         return true
     }

这个 ``preemptM`` 做的就是使用 tgkill 系统调用给要抢占的线程发送一个信号，literally。

    int tgkill(int tgid, int tid, int sig);

    tgkill() sends the signal sig to the thread with the thread ID tid in the thread group tgid. (By contrast, kill(2) can only be used to send a signal to a process (i.e., thread group) as a whole, and the signal will be delivered to an arbitrary thread within that process.)

    https://linux.die.net/man/2/tgkill

.. code-block:: go

    func preemptM(mp *m) {
        if atomic.Cas(&mp.signalPending, 0, 1) {
            signalM(mp, sigPreempt)
        }
    }

    func signalM(mp *m, sig int) {
        if atomic.Load(&touchStackBeforeSignal) != 0 {
            atomic.Cas((*uint32)(unsafe.Pointer(mp.gsignal.stack.hi-4)), 0, 0)
        }
        tgkill(getpid(), int(mp.procid), sig)
    }


信号处理函数在收到该信号后，会制造一个在当前指令处调用 ``asyncPreempt`` 函数的现场，这样在信号函数处理完，goroutine 返回执行后其会从 ``asyncPreempt`` 函数开始往下执行。

.. code-block:: go

    func sighandler(sig uint32, info *siginfo, ctxt unsafe.Pointer, gp *g) {
        c := &sigctxt{info, ctxt}
        //...
        if sig == sigPreempt {
            doSigPreempt(gp, c)
        }
        //...
    }

    func doSigPreempt(gp *g, ctxt *sigctxt) {
        if wantAsyncPreempt(gp) && isAsyncSafePoint(gp, ctxt.sigpc(), ctxt.sigsp(), ctxt.siglr()) {
            ctxt.pushCall(funcPC(asyncPreempt))
        }
    }

    func (c *sigctxt) pushCall(targetPC uintptr) {
        // 保存当前运行 goroutine 的指令指针寄存器到栈上，然后将指针指向 asyncPreempt
        // 这样就在当前指令处强制插入了一个函数调用 asyncPreempt，信号处理函数结束后 goroutine
        // 会从 asyncPreempt 开始执行
        pc := uintptr(c.rip())
        sp := uintptr(c.rsp())
        sp -= sys.PtrSize
        *(*uintptr)(unsafe.Pointer(sp)) = pc
        c.set_rsp(uint64(sp))
        c.set_rip(uint64(targetPC))
    }

``asyncPreempt`` 函数为保存当前的各种寄存器，然后调用 ``asyncPreempt2`` ，这个函数中会调用调度相关的函数抢占当前线程给其它 goroutine 去执行。

.. code-block:: asm

    TEXT ·asyncPreempt(SB),NOSPLIT|NOFRAME,$0-0
        ...
        MOVQ AX, 0(SP)
        MOVQ CX, 8(SP)
        ...
        MOVUPS X15, 352(SP)
        CALL ·asyncPreempt2(SB)
        MOVUPS 352(SP), X15
        ...
        MOVQ 8(SP), CX
        MOVQ 0(SP), AX
        ADJSP $-368
        POPFQ
        POPQ BP
        RET
