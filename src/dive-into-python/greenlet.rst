greenlet, eventlet, gevent etc
===================================

http://en.wikipedia.org/wiki/Coroutine

http://www.python.org/dev/peps/pep-0342/

greenlet的实现原理
---------------------

-let .suffix (forming nouns) Denoting a smaller or lesser kind

stackless

eventlet和gevent是基于greenlet的。

1. 创建一个greenlet。   ::

    typedef struct _greenlet {
            PyObject_HEAD
            char* stack_start;
            char* stack_stop;
            char* stack_copy;
            intptr_t stack_saved;
            struct _greenlet* stack_prev;
            struct _greenlet* parent;
            PyObject* run_info;
            struct _frame* top_frame;
            int recursion_depth;
            PyObject* weakreflist;
            PyObject* exc_type;
            PyObject* exc_value;
            PyObject* exc_traceback;
    } PyGreenlet;

2. greenlet.switch() ::

    static PyMethodDef green_methods[] = {
        // okay，入口函数是green_switch
        {"switch", (PyCFunction)green_switch,
         METH_VARARGS | METH_KEYWORDS, green_switch_doc},
        {"throw",  (PyCFunction)green_throw,  METH_VARARGS, green_throw_doc},
        {NULL,     NULL}            /* sentinel */
    };

    static PyObject* green_switch(
            PyGreenlet* self,
            PyObject* args,
            PyObject* kwargs)
    {
            if (!STATE_OK)
                    return NULL;
            Py_INCREF(args);
            Py_XINCREF(kwargs);
            return single_result(g_switch(self, args, kwargs));
    }

    static PyObject *
    g_switch(PyGreenlet* target, PyObject* args, PyObject* kwargs)
    {
        /* _consumes_ a reference to the args tuple and kwargs dict,
           and return a new tuple reference */

        /* check ts_current */
        if (!STATE_OK) {
            Py_DECREF(args);
            Py_XDECREF(kwargs);
            return NULL;
        }
        if (green_statedict(target) != ts_current->run_info) {
            PyErr_SetString(PyExc_GreenletError,
                    "cannot switch to a different thread");
            Py_DECREF(args);
            Py_XDECREF(kwargs);
            return NULL;
        }

        ts_passaround_args = args;
        ts_passaround_kwargs = kwargs;

        /* find the real target by ignoring dead greenlets,
           and if necessary starting a greenlet. */
        while (1) {
            // 如果目标greenlet已经创建并且未结束，切换到该greenlet
            if (PyGreenlet_ACTIVE(target)) {
                ts_target = target;
                g_switchstack();
                break;
            }

            // 如果目标greenlet还未创建，初始化该greenlet
            if (!PyGreenlet_STARTED(target)) {
                // 这个变量所在的内存地址为当前greenlet的stack_stop的位置
                void* dummymarker;
                ts_target = target;
                g_initialstub(&dummymarker);
                break;
            }

            target = target->parent;
        }

        /* We need to figure out what values to pass to the target greenlet
           based on the arguments that have been passed to greenlet.switch(). If
           switch() was just passed an arg tuple, then we'll just return that.
           If only keyword arguments were passed, then we'll pass the keyword
           argument dict. Otherwise, we'll create a tuple of (args, kwargs) and
           return both. */
        if (ts_passaround_kwargs == NULL)
        {
            g_passaround_return_args();
        }
        else if (PyDict_Size(ts_passaround_kwargs) == 0)
        {
            g_passaround_return_args();
        }
        else if (PySequence_Length(ts_passaround_args) == 0)
        {
            g_passaround_return_kwargs();
        }
        else
        {
            PyObject *tuple = PyTuple_New(2);
            PyTuple_SetItem(tuple, 0, ts_passaround_args);
            PyTuple_SetItem(tuple, 1, ts_passaround_kwargs);
            ts_passaround_args = NULL;
            ts_passaround_kwargs = NULL;
            return tuple;
        }
    }

    static void GREENLET_NOINLINE(g_initialstub)(void* mark)
    {
        int err;
        PyObject* o;

        /* ts_target.run is the object to call in the new greenlet */
        PyObject* run = PyObject_GetAttrString((PyObject*) ts_target, "run");
        if (run == NULL) {
            g_passaround_clear();
            return;
        }
        /* now use run_info to store the statedict */
        o = ts_target->run_info;
        ts_target->run_info = green_statedict(ts_target->parent);
        Py_INCREF(ts_target->run_info);
        Py_XDECREF(o);

        /* start the greenlet */
        ts_target->stack_start = NULL;
        ts_target->stack_stop = (char*) mark;
        if (ts_current->stack_start == NULL) {
            /* ts_current is dying */
            ts_target->stack_prev = ts_current->stack_prev;
        }
        else {
            ts_target->stack_prev = ts_current;
        }
        ts_target->top_frame = NULL;
        ts_target->exc_type = NULL;
        ts_target->exc_value = NULL;
        ts_target->exc_traceback = NULL;
        ts_target->recursion_depth = PyThreadState_GET()->recursion_depth;
        err = g_switchstack();
        /* returns twice!
           The 1st time with err=1: we are in the new greenlet
           The 2nd time with err=0: back in the caller's greenlet
        */
        if (err == 1) {
            /* in the new greenlet */
            PyObject* args;
            PyObject* kwargs;
            PyObject* result;
            PyGreenlet* ts_self = ts_current;
            ts_self->stack_start = (char*) 1;  /* running */

            args = ts_passaround_args;
            kwargs = ts_passaround_kwargs;
            if (args == NULL)    /* pending exception */
                result = NULL;
            else {
                /* call g.run(*args, **kwargs) */
                result = PyEval_CallObjectWithKeywords(
                    run, args, kwargs);
                Py_DECREF(args);
                Py_XDECREF(kwargs);
            }
            Py_DECREF(run);
            result = g_handle_exit(result);

            /* jump back to parent */
            ts_self->stack_start = NULL;  /* dead */
            g_switch(ts_self->parent, result, NULL);
            /* must not return from here! */
            PyErr_WriteUnraisable((PyObject *) ts_self);
            Py_FatalError("greenlets cannot continue");
        }
        /* back in the parent */
    }

    static int g_switchstack(void)
    {
        /* perform a stack switch according to some global variables
           that must be set before:
           - ts_current: current greenlet (holds a reference)
           - ts_target: greenlet to switch to
           - ts_passaround_args: NULL if PyErr_Occurred(),
                     else a tuple of args sent to ts_target (holds a reference)
           - ts_passaround_kwargs: same as ts_passaround_args
        */
        int err;
        {   /* save state */
            PyGreenlet* current = ts_current;
            PyThreadState* tstate = PyThreadState_GET();
            current->recursion_depth = tstate->recursion_depth;
            current->top_frame = tstate->frame;
            current->exc_type = tstate->exc_type;
            current->exc_value = tstate->exc_value;
            current->exc_traceback = tstate->exc_traceback;
        }
        err = slp_switch();
        if (err < 0) {   /* error */
            g_passaround_clear();
        }
        else {
            PyGreenlet* target = ts_target;
            PyGreenlet* origin = ts_current;
            PyThreadState* tstate = PyThreadState_GET();
            tstate->recursion_depth = target->recursion_depth;
            tstate->frame = target->top_frame;
            target->top_frame = NULL;
            tstate->exc_type = target->exc_type;
            target->exc_type = NULL;
            tstate->exc_value = target->exc_value;
            target->exc_value = NULL;
            tstate->exc_traceback = target->exc_traceback;
            target->exc_traceback = NULL;

            ts_current = target;
            Py_INCREF(target);
            Py_DECREF(origin);
        }
        return err;
    }

    platform/switch_x86_unix.h
    ===========================

    static int
    slp_switch(void)
    {
        void *ebp, *ebx;
        unsigned short cw;
        register int *stackref, stsizediff;
        __asm__ volatile ("" : : : "esi", "edi");
        __asm__ volatile ("fstcw %0" : "=m" (cw));
        __asm__ volatile ("movl %%ebp, %0" : "=m" (ebp));
        __asm__ volatile ("movl %%ebx, %0" : "=m" (ebx));
        // 取当前c stack的栈顶指针，当前greenlet stack_start的位置
        __asm__ ("movl %%esp, %0" : "=g" (stackref));
        {
            SLP_SAVE_STATE(stackref, stsizediff);
            __asm__ volatile (
                "addl %0, %%esp\n"
                "addl %0, %%ebp\n"
                :
                : "r" (stsizediff)
                );
            SLP_RESTORE_STATE();
        }
        __asm__ volatile ("movl %0, %%ebx" : : "m" (ebx));
        __asm__ volatile ("movl %0, %%ebp" : : "m" (ebp));
        __asm__ volatile ("fldcw %0" : : "m" (cw));
        __asm__ volatile ("" : : : "esi", "edi");
        return 0;
    }

    greenlet.c
    ==============

    #define SLP_SAVE_STATE(stackref, stsizediff)            \
      stackref += STACK_MAGIC;                              \
      if (slp_save_state((char*)stackref)) return -1;       \
      // 创建greenlet？直接返回1
      if (!PyGreenlet_ACTIVE(ts_target)) return 1;          \
      stsizediff = ts_target->stack_start - (char*)stackref

    #define SLP_RESTORE_STATE()                     \
      slp_restore_state()


    static int GREENLET_NOINLINE(slp_save_state)(char* stackref)
    {
        /* must free all the C stack up to target_stop */
        char* target_stop = ts_target->stack_stop;
        PyGreenlet* owner = ts_current;
        assert(owner->stack_saved == 0);
        if (owner->stack_start == NULL)
            owner = owner->stack_prev;  /* not saved if dying */
        else
            owner->stack_start = stackref;
        
        while (owner->stack_stop < target_stop) {
            /* ts_current is entierely within the area to free */
            if (g_save(owner, owner->stack_stop))
                return -1;  /* XXX */
            owner = owner->stack_prev;
        }
        if (owner != ts_target) {
            if (g_save(owner, target_stop))
                return -1;  /* XXX */
        }
        return 0;
    }

    static void GREENLET_NOINLINE(slp_restore_state)(void)
    {
        PyGreenlet* g = ts_target;
        PyGreenlet* owner = ts_current;
        
        /* Restore the heap copy back into the C stack */
        if (g->stack_saved != 0) {
            memcpy(g->stack_start, g->stack_copy, g->stack_saved);
            PyMem_Free(g->stack_copy);
            g->stack_copy = NULL;
            g->stack_saved = 0;
        }
        if (owner->stack_start == NULL)
            owner = owner->stack_prev; /* greenlet is dying, skip it */
        while (owner && owner->stack_stop <= g->stack_stop)
            owner = owner->stack_prev; /* find greenlet with more stack */
        g->stack_prev = owner;
    }

切换到目标greenlet时，需要将在目标greenlet之后创建的的greenlet执行的c stack现场
保存到堆上去，因为切换到目标greenlet后，其执行可能会覆盖这些stack。

所有的greenlet执行使用同一个PyThreadState。 ::

    PyThreadState <- frame1 <- frame11 <- frame12 <- frame13 ...frame1n <- top_frame
                             \_ frame21 <- frame22 <- frame23 ...

两个greenlet执行时，内存中PyFrame的大致是上图所示，切换greenlet时，python调用栈
的切换只是换一下top_frame的指针而已。

http://www.posix.nl/linuxassembly/nasmdochtml/nasmdoca.html

http://www.ibm.com/developerworks/linux/library/l-ia/index.html

gevent
---------

gevent2011.pdf

http://www.gevent.org/contents.html


Example by: http://www.gevent.org/intro.html#example 

::

    >>> import gevent
    >>> from gevent import socket
    >>> urls = ['www.google.com', 'www.example.com', 'www.python.org']
    >>> jobs = [gevent.spawn(socket.gethostbyname, url) for url in urls]
    >>> gevent.joinall(jobs, timeout=2)
    >>> [job.value for job in jobs]
    ['74.125.79.106', '208.77.188.166', '82.94.164.162']

+ greenlet的创建 

::

    __init__.py
    ===========

    from gevent.greenlet import Greenlet, joinall, killall
    spawn = Greenlet.spawn

    greenlet.py
    ===========

    from gevent.hub import greenlet, getcurrent, get_hub, GreenletExit, Waiter, PY3, iwait, wait

    class Greenlet(greenlet):
        """A light-weight cooperatively-scheduled execution unit."""

        @classmethod
        def spawn(cls, *args, **kwargs):
            """Return a new :class:`Greenlet` object, scheduled to start.

            The arguments are passed to :meth:`Greenlet.__init__`.
            """
            g = cls(*args, **kwargs)
            g.start()
            return g

        def __init__(self, run=None, *args, **kwargs):
            hub = get_hub()
            greenlet.__init__(self, parent=hub)
            if run is not None:
                self._run = run
            self.args = args
            self.kwargs = kwargs
            self._links = deque()
            self.value = None
            self._exception = _NONE
            loop = hub.loop
            self._notifier = loop.callback()
            self._start_event = None

        def start(self):
            """Schedule the greenlet to run in this loop iteration"""
            if self._start_event is None:
                # 添加一个伪监控事件，用于启动该greenlet
                self._start_event = self.parent.loop.callback()
                self._start_event.start(self.switch)

    def joinall(greenlets, timeout=None, raise_error=False, count=None):
        if not raise_error:
            # 等待所有的greenlets结束
            wait(greenlets, timeout=timeout)
        else:
            for obj in iwait(greenlets, timeout=timeout): 
                if getattr(obj, 'exception', None) is not None:
                    raise obj.exception
                if count is not None:
                    count -= 1
                    if count <= 0:
                        break

    hub.py
    ======

    def wait(objects=None, timeout=None, count=None):
        if objects is None:
            return get_hub().join(timeout=timeout)
        result = []
        if count is None:
            return list(iwait(objects, timeout))
        for obj in iwait(objects=objects, timeout=timeout):
            result.append(obj)
            count -= 1
            if count <= 0:
                break
        return result

    def iwait(objects, timeout=None):
        # QQQ would be nice to support iterable here that can be generated slowly (why?)
        waiter = Waiter()
        switch = waiter.switch
        if timeout is not None:
            timer = get_hub().loop.timer(timeout, priority=-1)
            timer.start(waiter.switch, _NONE)
        try:
            count = len(objects)
            for obj in objects:
                # 设置该greenlet结束后调用switch切会本greenlet
                obj.rawlink(switch)
            for _ in xrange(count):
                # 切到Hub，开始事件循环，等待有greenlet结束切会
                item = waiter.get()
                waiter.clear()
                if item is _NONE:
                    return
                yield item
        finally:
            if timeout is not None:
                timer.stop()
            for obj in objects:
                obj.unlink(switch)


+ greenlet的切换 

::

    socket.py
    =========

    class socket(object):

        def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, _sock=None):
            if _sock is None:
                self._sock = _realsocket(family, type, proto)
                self.timeout = _socket.getdefaulttimeout()
            else:
                if hasattr(_sock, '_sock'):
                    self._sock = _sock._sock
                    self.timeout = getattr(_sock, 'timeout', False)
                    if self.timeout is False:
                        self.timeout = _socket.getdefaulttimeout()
                else:
                    self._sock = _sock
                    self.timeout = _socket.getdefaulttimeout()
            self._sock.setblocking(0)
            fileno = self._sock.fileno()
            # 获取本线程的Hub
            self.hub = get_hub()
            io = self.hub.loop.io
            self._read_event = io(fileno, 1)
            self._write_event = io(fileno, 2)

       def accept(self):
            sock = self._sock
            while True:
                try:
                    client_socket, address = sock.accept()
                    break
                except error:
                    ex = sys.exc_info()[1]
                    if ex[0] != EWOULDBLOCK or self.timeout == 0.0:
                        raise
                    sys.exc_clear()
                # EAGAIN，等待对self._sock的读事件
                self._wait(self._read_event)
            return socket(_sock=client_socket), address

        def _wait(self, watcher, timeout_exc=timeout('timed out')):
            if self.timeout is not None:
                timeout = Timeout.start_new(self.timeout, timeout_exc, ref=False)
            else:
                timeout = None
            try:
                # XXX
                self.hub.wait(watcher)
            finally:
                if timeout is not None:
                    timeout.cancel()

    hub.py
    ======

    class Hub(greenlet):
        """A greenlet that runs the event loop.

        It is created automatically by :func:`get_hub`.
        """

    ...

        def switch(self):
            exc_type, exc_value = sys.exc_info()[:2]
            try:
                switch_out = getattr(getcurrent(), 'switch_out', None)
                if switch_out is not None:
                    switch_out()
                exc_clear()
                return greenlet.switch(self)
            finally:
                set_exc_info(exc_type, exc_value)

        def wait(self, watcher):
            waiter = Waiter()
            unique = object()
            # 添加新的事件监控，事件为watcher，回调函数为waiter.switch
            watcher.start(waiter.switch, unique)
            try:
                # XXX
                result = waiter.get()
                assert result is unique, 'Invalid switch into %s: %r (expected %r)' % (getcurrent(), result, unique)
            finally:
                watcher.stop()

    ...


    class Waiter(object):
        """A low level communication utility for greenlets."""

    ...

        def __init__(self, hub=None):
            if hub is None:
                # 获取本线程的的Hub
                self.hub = get_hub()
            else:
                self.hub = hub
            self.greenlet = None
            self.value = None
            self._exception = _NONE

        def switch(self, value=None):
            """Switch to the greenlet if one's available. Otherwise store the value."""
            if self.greenlet is None:
                self.value = value
                self._exception = None
            else:
                assert getcurrent() is self.hub, "Can only use Waiter.switch method from the Hub greenlet"
                try:
                    # 切回到self.greenlet
                    self.greenlet.switch(value)
                except:
                    self.hub.handle_error(self.greenlet.switch, *sys.exc_info())

        def get(self):
            """If a value/an exception is stored, return/raise it. Otherwise until switch() or throw() is called."""
            if self._exception is not _NONE:
                if self._exception is None:
                    return self.value
                else:
                    getcurrent().throw(*self._exception)
            else:
                assert self.greenlet is None, 'This Waiter is already used by %r' % (self.greenlet, )
                # 记录下当前的greenlet为self.greenlet
                self.greenlet = getcurrent()
                try:
                    # 切换到Hub这个greenlet，等待Hub切回
                    return self.hub.switch()
                finally:
                    self.greenlet = None

总结：

gevent还是有一个事件循环的，只是不需要显式的调用而已。

::

    main greenlet  ->  hub  -> g1/g2/g3/g4

1. 创建hub这个greenlet，所有spawn出来的greenlet使用callback伪事件（该事件随时触发）注册到hub。
2. 切换到hub，开始事件循环。
3. spawn出来的greenlet遇到阻塞时注册对应的io/timer/...事件，并切换到hub。
4. spawn出来的greenlet执行结束后会switch到main greenlet，再从main greenlet switch到hub。
5. 如此循环直至所有的greenlet执行结束为止。


gunicorn
----------

**TornadoWorker** 

:: 

    class TornadoWorker(Worker):

        @classmethod
        def setup(cls):
            # patch web.RequestHandler.clear
            web = sys.modules.pop("tornado.web")
            old_clear = web.RequestHandler.clear

            def clear(self):
                old_clear(self)
                self._headers["Server"] += " (Gunicorn/%s)" % gversion
            web.RequestHandler.clear = clear
            sys.modules["tornado.web"] = web

        def handle_quit(self, sig, frame):
            super(TornadoWorker, self).handle_quit(sig, frame)
            self.ioloop.stop()

        def handle_request(self):
            self.nr += 1
            if self.alive and self.nr >= self.max_requests:
                self.alive = False
                self.log.info("Autorestarting worker after current request.")
                self.ioloop.stop()

        def watchdog(self):
            if self.alive:
                self.notify()

            if self.ppid != os.getppid():
                self.log.info("Parent changed, shutting down: %s", self)
                self.ioloop.stop()

        def run(self):
            self.socket.setblocking(0)
            self.ioloop = IOLoop.instance()
            self.alive = True
            # 让tornado定时执行self.watchdog函数
            PeriodicCallback(self.watchdog, 1000, io_loop=self.ioloop).start()

            # Assume the app is a WSGI callable if its not an
            # instance of tornardo.web.Application
            app = self.wsgi
            if not isinstance(app, tornado.web.Application) or \
               isinstance(app, tornado.wsgi.WSGIApplication):
                app = WSGIContainer(app)

            # Monkey-patching HTTPConnection.finish to count the
            # number of requests being handled by Tornado. This
            # will help gunicorn shutdown the worker if max_requests
            # is exceeded.
            httpserver = sys.modules["tornado.httpserver"]
            old_connection_finish = httpserver.HTTPConnection.finish

            def finish(other):
                self.handle_request()
                old_connection_finish(other)
            httpserver.HTTPConnection.finish = finish
            sys.modules["tornado.httpserver"] = httpserver

            server = tornado.httpserver.HTTPServer(app, io_loop=self.ioloop)
            if hasattr(server, "add_socket"):  # tornado > 2.0
                server.add_socket(self.socket)
            elif hasattr(server, "_sockets"):  # tornado 2.0
                server._sockets[self.socket.fileno()] = self.socket
            else:  # tornado 1.2 or earlier
                server._socket = self.socket

            server.no_keep_alive = self.cfg.keepalive <= 0
            server.xheaders = bool(self.cfg.x_forwarded_for_header)

            server.start(num_processes=1)

            # Torando主循环
            self.ioloop.start()


