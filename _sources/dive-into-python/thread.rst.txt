Python中多线程的实现
==========================

Python在Py_Initialize中会创建一个默认的PyInterpreterState对象以及一个默认的
PyThreadState 对象。默认情况下不会初始化线程环境（也就是创建GIL），这个任务
是在第一次调用thread.start_new_thread是初始化的。

http://docs.python.org/c-api/init.html#thread-state-and-the-global-interpreter-lock

http://www.linuxjournal.com/article/3641

线程的创建 
------------

::

    Modules/threadmodule.c
    ========================

    static PyObject *
    thread_PyThread_start_new_thread(PyObject *self, PyObject *fargs)
    {
        PyObject *func, *args, *keyw = NULL;
        struct bootstate *boot;
        long ident;

        if (!PyArg_UnpackTuple(fargs, "start_new_thread", 2, 3,
                               &func, &args, &keyw))
            return NULL;
        if (!PyCallable_Check(func)) {
            PyErr_SetString(PyExc_TypeError,
                            "first arg must be callable");
            return NULL;
        }
        if (!PyTuple_Check(args)) {
            PyErr_SetString(PyExc_TypeError,
                            "2nd arg must be a tuple");
            return NULL;
        }
        if (keyw != NULL && !PyDict_Check(keyw)) {
            PyErr_SetString(PyExc_TypeError,
                            "optional 3rd arg must be a dictionary");
            return NULL;
        }
        
        boot = PyMem_NEW(struct bootstate, 1);
        if (boot == NULL)
            return PyErr_NoMemory();
        boot->interp = PyThreadState_GET()->interp;
        boot->func = func;
        boot->args = args;
        boot->keyw = keyw;
        // 创建新线程对应的PyThreadState结构
        boot->tstate = _PyThreadState_Prealloc(boot->interp);
        if (boot->tstate == NULL) {
            PyMem_DEL(boot);
            return PyErr_NoMemory();
        }
        Py_INCREF(func);
        Py_INCREF(args);
        Py_XINCREF(keyw);
        // 初始化线程环境
        PyEval_InitThreads();
        // 如果是pthread库，这个函数基本等于pthread_create
        ident = PyThread_start_new_thread(t_bootstrap, (void*) boot);
        if (ident == -1) {
            PyErr_SetString(ThreadError, "can't start new thread");
            Py_DECREF(func);
            Py_DECREF(args);
            Py_XDECREF(keyw);
            PyThreadState_Clear(boot->tstate);
            PyMem_DEL(boot);
            return NULL;
        }
        return PyInt_FromLong(ident);
    }

    Python/pystate.c
    ==================

    PyThreadState *_PyThreadState_Current = NULL;

    PyThreadState *
    PyThreadState_Swap(PyThreadState *newts)
    {  
        PyThreadState *oldts = _PyThreadState_Current;
        _PyThreadState_Current = newts;

        return oldts;
    }

    Python/ceval.c
    ===============

    // 这个就是GIL了
    static PyThread_type_lock interpreter_lock = 0;

    void
    PyEval_InitThreads(void)
    {
        if (interpreter_lock)
            return;
        // 在这里创建GIL
        interpreter_lock = PyThread_allocate_lock();
        PyThread_acquire_lock(interpreter_lock, 1);
        main_thread = PyThread_get_thread_ident();
    } 

    Modules/threadmodule.c
    =========================

    static void
    t_bootstrap(void *boot_raw)
    {
        struct bootstate *boot = (struct bootstate *) boot_raw;
        PyThreadState *tstate;
        PyObject *res;

        tstate = boot->tstate;
        tstate->thread_id = PyThread_get_thread_ident();
        _PyThreadState_Init(tstate);
        PyEval_AcquireThread(tstate);
        res = PyEval_CallObjectWithKeywords(
            boot->func, boot->args, boot->keyw);
        if (res == NULL) {
            if (PyErr_ExceptionMatches(PyExc_SystemExit))
                PyErr_Clear();
            else {
                PyObject *file;
                PySys_WriteStderr(
                    "Unhandled exception in thread started by ");
                file = PySys_GetObject("stderr");
                if (file)
                    PyFile_WriteObject(boot->func, file, 0);
                else
                    PyObject_Print(boot->func, stderr, 0);
                PySys_WriteStderr("\n");
                PyErr_PrintEx(0);
            }
        }
        else
            Py_DECREF(res);
        Py_DECREF(boot->func);
        Py_DECREF(boot->args);
        Py_XDECREF(boot->keyw);
        PyMem_DEL(boot_raw);
        PyThreadState_Clear(tstate);
        PyThreadState_DeleteCurrent();
        PyThread_exit_thread();
    }

    Python/ceval.c
    ================

    void
    PyEval_AcquireThread(PyThreadState *tstate)
    {   
        if (tstate == NULL)
            Py_FatalError("PyEval_AcquireThread: NULL new thread state");
        /* Check someone has called PyEval_InitThreads() to create the lock */
        assert(interpreter_lock);
        // 请求获取GIL
        PyThread_acquire_lock(interpreter_lock, 1);
        // Got it! 我们现在是当前线程了，设置全局的PyThreadState指针
        if (PyThreadState_Swap(tstate) != NULL)
            Py_FatalError(
                "PyEval_AcquireThread: non-NULL old thread state");
    }


线程的调度 
---------------

1. 标准调度 :: 

    Python/ceval.c
    ===============

    volatile int _Py_Ticker = 100;

    PyObject *
    PyEval_EvalFrameEx(PyFrameObject *f, int throwflag)
    {
        ...

        PyThreadState *tstate = PyThreadState_GET();

        ...

        for (;;) {
            ...

            if (--_Py_Ticker < 0) {
                if (interpreter_lock) {

                    // 保存状态，释放GIL，从而触发操作系统进行线程的切换
                    if (PyThreadState_Swap(NULL) != tstate)
                        Py_FatalError("ceval: tstate mix-up");
                    PyThread_release_lock(interpreter_lock);

                    // 请求GIL，等待下次被操作系统调度
                    PyThread_acquire_lock(interpreter_lock, 1);
                    if (PyThreadState_Swap(tstate) != NULL)
                        Py_FatalError("ceval: orphan tstate");

                    ...
                }
            }

        fast_next_code:
            
            // dispatch opcode and execute
            ...
        }

        ...
    }

2. 阻塞调度 ::


    #define Py_BEGIN_ALLOW_THREADS { \
                            PyThreadState *_save; \
                            _save = PyEval_SaveThread();

    PyThreadState *
    PyEval_SaveThread(void)
    {
        PyThreadState *tstate = PyThreadState_Swap(NULL);
        if (tstate == NULL)
            Py_FatalError("PyEval_SaveThread: NULL tstate");

        if (interpreter_lock)
            PyThread_release_lock(interpreter_lock);

        return tstate;
    }

    #define Py_END_ALLOW_THREADS    PyEval_RestoreThread(_save); \
                     }

   在C extension中需要调用阻塞函数的时候时候会用到这两个宏，使用Py_BEGIN_ALLOW_THREADS
   保存当前线程状态，主动释放GIL，从而让其它线程可以获得调度的机会，这个时候才是
   实际意义上的多线程。阻塞函数返回后，需要操作Python对象时，在Py_END_ALLOW_THREADS
   重新请求获取GIL。

   multiprocessing


PyGILState*函数
-----------------

   使用Python的thread模块创建出来的线程，Python会自动为其创建对应的PyThreadState对象，
   管理GIL。这些thread中的代码可以直接调用Python/C API。
  
   但是对于embed python或者python c extension中自行创建的线程，如果在这些线程需要调用
   Python/C API，就必须创建自己的PyThreadState对象，并且在操作Python API之前获取GIL，
   对于这类应用场景的支持，Python提供了PyGILState*函数。 ::

    PyGILState_STATE
    PyGILState_Ensure(void)
    {
        int current;
        PyThreadState *tcur;
        /* Note that we do not auto-init Python here - apart from
           potential races with 2 threads auto-initializing, pep-311
           spells out other issues.  Embedders are expected to have
           called Py_Initialize() and usually PyEval_InitThreads().
        */
        assert(autoInterpreterState); /* Py_Initialize() hasn't been called! */
        
        // 获取本线程的PyThreadState对象
        tcur = (PyThreadState *)PyThread_get_key_value(autoTLSkey);
        if (tcur == NULL) {
            /* Create a new thread state for this thread */
            tcur = PyThreadState_New(autoInterpreterState);
            if (tcur == NULL)
                Py_FatalError("Couldn't create thread-state for new thread");
            /* This is our thread state!  We'll need to delete it in the
               matching call to PyGILState_Release(). */
            tcur->gilstate_counter = 0;
            current = 0; /* new thread state is never current */
        }
        else
            // Python线程在获得GIL之后，首先会将全局的当前ThreadState对象换成
            // 本线程的PyThreadState对象，同样在释放GIL前，也会首先保存下这个
            // 全局的当前ThreadState对象。
            // 所以可以通过判断全局的当前线程ThreadState对象等于tcur判断本线程
            // 是否已经获得了GIL。
            current = PyThreadState_IsCurrent(tcur);
        if (current == 0)
            // 如果没有获取GIL，那么这里请求GIL。
            PyEval_RestoreThread(tcur);
        /* Update our counter in the thread-state - no need for locks:
           - tcur will remain valid as we hold the GIL.
           - the counter is safe as we are the only thread "allowed"
             to modify this value
        */
        ++tcur->gilstate_counter;
        return current ? PyGILState_LOCKED : PyGILState_UNLOCKED;
    }

    void
    PyGILState_Release(PyGILState_STATE oldstate)
    {
        PyThreadState *tcur = (PyThreadState *)PyThread_get_key_value(
                                                                autoTLSkey);
        if (tcur == NULL)
            Py_FatalError("auto-releasing thread-state, "
                          "but no thread-state for this thread");
        /* We must hold the GIL and have our thread state current */
        /* XXX - remove the check - the assert should be fine,
           but while this is very new (April 2003), the extra check
           by release-only users can't hurt.
        */
        if (! PyThreadState_IsCurrent(tcur))
            Py_FatalError("This thread state must be current when releasing");
        assert(PyThreadState_IsCurrent(tcur));
        --tcur->gilstate_counter;
        assert(tcur->gilstate_counter >= 0); /* illegal counter value */

        /* If we're going to destroy this thread-state, we must
         * clear it while the GIL is held, as destructors may run.
         */
        if (tcur->gilstate_counter == 0) {
            /* can't have been locked when we created it */
            assert(oldstate == PyGILState_UNLOCKED);
            PyThreadState_Clear(tcur);
            /* Delete the thread-state.  Note this releases the GIL too!
             * It's vital that the GIL be held here, to avoid shutdown
             * races; see bugs 225673 and 1061968 (that nasty bug has a
             * habit of coming back).
             */
            PyThreadState_DeleteCurrent();
        }
        /* Release the lock if necessary */
        else if (oldstate == PyGILState_UNLOCKED)
            PyEval_SaveThread();
    }
