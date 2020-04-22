Python中的信号处理
--------------------

::

    Modules/signalmodule.c
    ========================

    /*
       NOTES ON THE INTERACTION BETWEEN SIGNALS AND THREADS

       When threads are supported, we want the following semantics:

       - only the main thread can set a signal handler
       - any thread can get a signal handler
       - signals are only delivered to the main thread

        ...
    */

    static struct {
        int tripped;
        PyObject *func;
    } Handlers[NSIG];

    static PyObject *
    signal_signal(PyObject *self, PyObject *args)
    {
        PyObject *obj;
        int sig_num;
        PyObject *old_handler;
        void (*func)(int);
        if (!PyArg_ParseTuple(args, "iO:signal", &sig_num, &obj))
            return NULL;
    #ifdef WITH_THREAD
        if (PyThread_get_thread_ident() != main_thread) {
            PyErr_SetString(PyExc_ValueError,
                            "signal only works in main thread");
            return NULL;
        }
    #endif
        if (sig_num < 1 || sig_num >= NSIG) {
            PyErr_SetString(PyExc_ValueError,
                            "signal number out of range");
            return NULL;
        }
        if (obj == IgnoreHandler)
            func = SIG_IGN;
        else if (obj == DefaultHandler)
            func = SIG_DFL;
        else if (!PyCallable_Check(obj)) {
            PyErr_SetString(PyExc_TypeError,
    "signal handler must be signal.SIG_IGN, signal.SIG_DFL, or a callable object");
                    return NULL;
        }
        else
            // 设置信号的处理函数为signal_handler
            func = signal_handler;
        if (PyOS_setsig(sig_num, func) == SIG_ERR) {
            PyErr_SetFromErrno(PyExc_RuntimeError);
            return NULL;
        }

        // 这里保存的才是实际设置的处理函数
        old_handler = Handlers[sig_num].func;
        Handlers[sig_num].tripped = 0;
        Py_INCREF(obj);
        Handlers[sig_num].func = obj;
        return old_handler;
    }

    static void
    signal_handler(int sig_num)
    {
    #ifdef WITH_THREAD
    #ifdef WITH_PTH
        if (PyThread_get_thread_ident() != main_thread) {
            pth_raise(*(pth_t *) main_thread, sig_num);
            return;
        }
    #endif
        /* See NOTES section above */
        if (getpid() == main_pid) {
    #endif
            // 这个信号被触发了
            Handlers[sig_num].tripped = 1;
            /* Set is_tripped after setting .tripped, as it gets
               cleared in PyErr_CheckSignals() before .tripped. */
            is_tripped = 1;
            // 添加调用信号处理函数的pending call
            Py_AddPendingCall(checksignals_witharg, NULL);
            if (wakeup_fd != -1)
                write(wakeup_fd, "\0", 1);
    #ifdef WITH_THREAD
        }
    #endif
    #ifdef SIGCHLD
        if (sig_num == SIGCHLD) {
            /* To avoid infinite recursion, this signal remains
               reset until explicit re-instated.
               Don't clear the 'func' field as it is our pointer
               to the Python handler... */
            return;
        }
    #endif
    #ifndef HAVE_SIGACTION
        /* If the handler was not set up with sigaction, reinstall it.  See
         * Python/pythonrun.c for the implementation of PyOS_setsig which
         * makes this true.  See also issue8354. */
        PyOS_setsig(sig_num, signal_handler);
    #endif
    }

    Python/ceval.c
    ===============

    int
    Py_AddPendingCall(int (*func)(void *), void *arg)
    {
        static volatile int busy = 0;
        int i, j;
        /* XXX Begin critical section */
        /* XXX If you want this to be safe against nested
           XXX asynchronous calls, you'll have to work harder! */
        if (busy)
            return -1;
        busy = 1;
        i = pendinglast;
        j = (i + 1) % NPENDINGCALLS;
        if (j == pendingfirst) {
            busy = 0;
            return -1; /* Queue full */
        }
        pendingcalls[i].func = func;
        pendingcalls[i].arg = arg;
        pendinglast = j;

        _Py_Ticker = 0;
        things_to_do = 1; /* Signal main loop */
        busy = 0;
        /* XXX End critical section */
        return 0;
    }

    PyObject *
    PyEval_EvalFrameEx(PyFrameObject *f, int throwflag)
    {

        ...

        for (;;) {

            ...

            if (--_Py_Ticker < 0) {
                if (*next_instr == SETUP_FINALLY) {
                    /* Make the last opcode before
                       a try: finally: block uninterruptable. */
                    goto fast_next_opcode;
                }
                _Py_Ticker = _Py_CheckInterval;
                tstate->tick_counter++;

                if (things_to_do) {
                    // 调用pending calls，信号处理函数是在这个里面处理的。
                    if (Py_MakePendingCalls() < 0) {
                        why = WHY_EXCEPTION;
                        goto on_error;
                    }
                    if (things_to_do)
                        /* MakePendingCalls() didn't succeed.
                           Force early re-execution of this
                           "periodic" code, possibly after
                           a thread switch */
                        _Py_Ticker = 0;
                }

            ...
        }
    }

    int
    Py_MakePendingCalls(void)
    {
        static int busy = 0;
    #ifdef WITH_THREAD
        // !!!只有在主线程中才能执行
        if (main_thread && PyThread_get_thread_ident() != main_thread)
            return 0;
    #endif
        if (busy)
            return 0;
        busy = 1;
        things_to_do = 0;
        for (;;) {
            int i;
            int (*func)(void *);
            void *arg;
            i = pendingfirst;
            if (i == pendinglast)
                break; /* Queue empty */
            func = pendingcalls[i].func;
            arg = pendingcalls[i].arg;
            pendingfirst = (i + 1) % NPENDINGCALLS;
            if (func(arg) < 0) {
                busy = 0;
                things_to_do = 1; /* We're not done yet */
                return -1;
            }
        }
        busy = 0;
        return 0;
    }

Python中的信号是异步处理的，信号处理函数只有主线程才能设置，

Py_AddPendingCall是个好东西，可以用其往运行中的Python虚拟机中插入执行逻辑。

PyErr_SetInterrupt()可以用来停止正在运行中的Python虚拟机。


unicode
---------

::

    binascii.b2a_base64(u'你好')
    Traceback (most recent call last):
      File "<stdin>", line 1, in <module>
      UnicodeEncodeError: 'ascii' codec can't encode characters in position 0-1: ordinal not in range(128)

    static PyObject *
    binascii_b2a_base64(PyObject *self, PyObject *args)
    {
        ...

        if ( !PyArg_ParseTuple(args, "s#:b2a_base64", &bin_data, &bin_len) )
            return NULL;

        ...
    }

    int
    PyArg_ParseTuple(PyObject *args, const char *format, ...)
    {
        int retval;
        va_list va;

        va_start(va, format);
        retval = vgetargs1(args, format, &va, 0);
        va_end(va);
        return retval;
    }

    static int
    vgetargs1(PyObject *args, const char *format, va_list *p_va, int flags)
    {
        ...

        while (endfmt == 0) {
            int c = *format++;
            switch (c) {

            ...

            case 's':

            ...

            } else if (*format == '#') {
                void **p = (void **)va_arg(*p_va, char **);
                FETCH_SIZE;

                if (PyString_Check(arg)) {
                    *p = PyString_AS_STRING(arg);
                    STORE_SIZE(PyString_GET_SIZE(arg));
                }
    #ifdef Py_USING_UNICODE
                else if (PyUnicode_Check(arg)) {

                    // !!!如果是unicode字符串，将其转化为默认编码。
                    uarg = UNICODE_DEFAULT_ENCODING(arg);
                    if (uarg == NULL)
                        return converterr(CONV_UNICODE,
                                          arg, msgbuf, bufsize);
                    *p = PyString_AS_STRING(uarg);
                    STORE_SIZE(PyString_GET_SIZE(uarg));
                }
    #endif
                ...
            }

            ...
        }

        ...
    }


Python中的默认编码是ascii，编码规则为 ::

    If the code point is < 128, each byte is the same as the value of the code point.
    If the code point is 128 or greater, the Unicode string can’t be represented in this encoding. (Python raises a UnicodeEncodeError exception in this case.)

so，就看到了上面的那个异常，当然上面的例子也是有问题的，Unicode不是一个Portable
的格式，将其base64编码是没有意义的，一般在网络中交换数据时都是先转换为基于字节编
码的utf-8格式。（还是Unicode，只是表现形式不一样而已）。

关于 `# -*- coding: utf-8 -*-`

::

    Gramma/Gramma
    ===============
    # not used in grammar, but may appear in "node" passed from Parser to Compiler
    encoding_decl: NAME

http://docs.python.org/howto/unicode.html

socket模块跨平台dup的实现
-------------------------

在本地起一个server监听8080端口 ::

    alan@sina:~$ nc -l 8080

打开python shell，输入如下代码 ::

    >>> import socket
    >>> s = socket.socket()
    >>> s.connect(('localhost', 8080))
    >>> _s = s._sock
    >>> s.send('before close\n')
    13
    >>> s.close()
    >>> s.send('after close by s')
    Traceback (most recent call last):
      File "<stdin>", line 1, in <module>
      File "/usr/lib/python2.6/socket.py", line 165, in _dummy
        raise error(EBADF, 'Bad file descriptor')
    socket.error: [Errno 9] Bad file descriptor
    >>> _s.send('after close by _s')
    17

以下为nc的输出： ::

    before close
    after close by _s

看一下socket模块的代码 ::

    socket.py
    =========

    def close(self):
        # 只是将self._sock的引用减1，
        # 并且将self._sock替换为_closesocket的实例。
        self._sock = _closedsocket()
        dummy = self._sock._dummy
        for method in _delegate_methods:
            setattr(self, method, dummy)

socket是一个container对象，保存了实际的_socket对象（_sock）。

对于一个socket的实例，如果调用了makefile或者dup等操作，会使该实例的_sock的引用计
数不为1，这个时候调用socket的close方法不会关闭实际的连接，只是后续所有的操作变成
了BADF异常，但实际持有_sock的引用者依然可以对该连接操作。只有在_sock的引用计数减
至0的时候，实际的连接才会被关闭。_socket.close也是实际的关闭。

P.S 因为需要将httplib模块使用的socket模块替换为有限制的intern_socket模块，过程中
总是出现读完http header后，body莫名其妙timeout的问题，最后检查发现跟这个有关。

poll在fd已经是-1的时候居然还返回超时阿！坑爹呢阿！


number_hack.py
----------------

http://gist.github.com/1208215

::

    import sys
    import ctypes
    pyint_p = ctypes.POINTER(ctypes.c_byte*sys.getsizeof(5))
    five = ctypes.cast(id(5), pyint_p)
    print(2 + 2 == 5) # False
    five.contents[five.contents[:].index(5)] = 4
    print(2 + 2 == 5) # True (must be sufficiently large values of 2 there...)

id(object): This is the address of the object in memory.

int object的结构： ::

    Include/intobject.h
    ===================
    typedef struct {
        PyObject_HEAD
        long ob_ival;
    } PyIntObject;

    #define PyObject_HEAD                   \
        _PyObject_HEAD_EXTRA                \
        Py_ssize_t ob_refcnt;               \
        struct _typeobject *ob_type;

five中的内容结构如下: ::

    >>> five.contents[:]
    [17, 0, 0, 0, 0, -23, 34, 8, 5, 0, 0, 0]
    | ob_refcnt | ob_type      | ob_ival   |

小整数在python中是共享的，所以所有的object(5)在python中都是引用的同一个对象，上
面的代码修改了这个对象中ob_ival字段，所以所有的object(5)里面的raw数值就变成了4，
所以。

::

    Objects/intobject.c
    ===================
    PyObject *
    PyInt_FromLong(long ival)
    {
        register PyIntObject *v;

        ...

        if (-NSMALLNEGINTS <= ival && ival < NSMALLPOSINTS) {
            v = small_ints[ival + NSMALLNEGINTS];
            Py_INCREF(v);

            ...

            return (PyObject *) v;
        }

        ...
    }


再改回去: ::

    pychar_p = ctypes.POINTER(ctypes.c_char*sys.getsizeof(1))
    five1 = ctypes.cast(id(5), pychar_p)
    five1.contents[8] = '\x05'

p.s. 查找替换5为4的过程还是是有问题的。如果在ob_refcnt或ob_type的任意一个字节
里出现了5，就挂了。应该是找最后一个5才行。

Bound method, Unbound Method etc
-----------------------------------

::

    >>> class A(object):
    ...     def foo(x, y):
    ...             return x + y
    ...
    >>> A.__dict__
    <dictproxy object at 0xb77c9524>
    >>> A.foo
    <unbound method A.foo>
    >>> A.foo(1, 2)
    Traceback (most recent call last):
      File "<stdin>", line 1, in <module>
    TypeError: unbound method foo() must be called with A instance as first argument (got int instance instead)
    >>> A.__dict__['foo']
    <function foo at 0xb770133c>
    >>> A.__dict__['foo'](1, 1)
    2

现在我们来看看代码，解释以下为什么A.foo变成了和实际的foo不一样的东西。

::

    >>> import dis
    >>> dis.dis(compile('A.foo', '<none>', 'exec'))
      1           0 LOAD_NAME                0 (a)
                  3 LOAD_ATTR                1 (foo)
                  6 POP_TOP
                  7 LOAD_CONST               0 (None)
                 10 RETURN_VALUE

    Python/ceval.c
    ==============
    case LOAD_ATTR:
        w = GETITEM(names, oparg);
        v = TOP();
        x = PyObject_GetAttr(v, w);
        Py_DECREF(v);
        SET_TOP(x);
        if (x != NULL) continue;
        break;

    Objects/object.c
    ================
    PyObject *
    PyObject_GetAttr(PyObject *v, PyObject *name)
    {
        // #define Py_TYPE(ob) (((PyObject*)(ob))->ob_type)
        PyTypeObject *tp = Py_TYPE(v);

        if (!PyString_Check(name)) {
            {
                PyErr_Format(PyExc_TypeError,
                             "attribute name must be string, not '%.200s'",
                             Py_TYPE(name)->tp_name);
                return NULL;
            }
        }
        if (tp->tp_getattro != NULL)
            return (*tp->tp_getattro)(v, name);
        if (tp->tp_getattr != NULL)
            return (*tp->tp_getattr)(v, PyString_AS_STRING(name));
        PyErr_Format(PyExc_AttributeError,
                     "'%.50s' object has no attribute '%.400s'",
                     tp->tp_name, PyString_AS_STRING(name));
        return NULL;
    }

    ...

    static PyObject *
    func_descr_get(PyObject *func, PyObject *obj, PyObject *type)
    {
        if (obj == Py_None)
            obj = NULL;
        return PyMethod_New(func, obj, type);
    }

    PyObject *
    PyDescr_NewMethod(PyTypeObject *type, PyMethodDef *method)
    {
        PyMethodDescrObject *descr;

        descr = (PyMethodDescrObject *)descr_new(&PyMethodDescr_Type,
                                                 type, method->ml_name);
        if (descr != NULL)
            descr->d_method = method;
        return (PyObject *)descr;
    }

    static PyTypeObject PyMethodDescr_Type = {
        PyVarObject_HEAD_INIT(&PyType_Type, 0)
        "method_descriptor",
        sizeof(PyMethodDescrObject),

        ...

        (descrgetfunc)method_get,                   /* tp_descr_get */
        0,                                          /* tp_descr_set */
    };

递归 & Y-Combinator
--------------------

求10!  ::

    def f(n):
        if n < 2: return 1
        else: return n * f(n-1)

使用尾递归 ::

    def f(n, m):
        if n < 2: return m
        else: return f(n-1, n*m)

    print f(10, 1)

递归能够实现是因为在 `def ....` 定义函数的时候在当前的namespace里加入了 `f` 这个
变量指向这个函数。

但是这个变量并不是必须的，匿名函数一样可以实现递归，通过Y combinator。 ::

    Y is a function that takes a function that could be viewed as describing a
    recursive or self-referential function, and returns another function that
    implements that recursive function.

以下是Y cominator的推导过程。基本是 www.dreamsongs.com/Files/WhyOfY.pdf 这篇文章
的一个python版 ::

    # currying
    # http://en.wikipedia.org/wiki/Currying
    >>> apply(lambda a, b: a + b, (1, 2)) == apply(apply(lambda a: lambda b: a + b, (1,)), (2,))

首先，使用匿名函数来实现10！ ::

    >>> g = lambda h, n: 1 if n < 2 else n*apply(h, (h, n-1))
    >>> apply(g, (g, 10))
    3628800

第一步，currying ::

    >>> g = lambda h: lambda n: 1 if n < 2 else n*apply(apply(h, (h,)), (n-1,))
    >>> apply(apply(g, (g,)), (10,))
    3628800

第二步，从 `1 if n < 2 else n*apply(apply(h, (h,)), (n-1,))` 中提取出 `apply(h, (h,))` ::

    >>> f = lambda q, n: 1 if n < 2 else n*apply(q, (n-1,))
    >>> apply(f, ((apply(h, (h,)), n)))

从而整个函数可以改写为 ::

    >>> g = lambda h: lambda n: apply(f, (apply(h, (h,)), n))
    >>> apply(apply(g, (g,)), (10,))
    3628800

最后，合并为： ::

    >>> Y = lambda f: apply(lambda h: lambda n: apply(f, (apply(h, (h,)), n)), (lambda h: lambda n: apply(f, (apply(h, (h,)), n)),))
    >>> apply(apply(Y, (f,)), (10,))
    >>> Y(f)(10)

使用Y  Combinator计算Fibonacci number ::

    >>> Y(lambda q, n: n if n < 2 else apply(q, (n-1,)) + apply(q, (n-2,)))(10)

more:

http://en.wikipedia.org/wiki/Fixed-point_combinator#Y_combinator

http://en.wikipedia.org/wiki/Lambda_calculus

