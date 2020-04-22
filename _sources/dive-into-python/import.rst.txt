Import模块分析
------------------

::

    >>> dis.dis(compile("import os", "<none>", "exec"))
      1           0 LOAD_CONST               0 (-1)
                  3 LOAD_CONST               1 (None)
                  6 IMPORT_NAME              0 (os)
                  9 STORE_NAME               0 (os)
                 12 LOAD_CONST               1 (None)
                 15 RETURN_VALUE

    Python/ceval.c
    ==============

    case IMPORT_NAME:
        w = GETITEM(names, oparg);

        // 取__import__这个builtin函数
        x = PyDict_GetItemString(f->f_builtins, "__import__");
        if (x == NULL) {
            PyErr_SetString(PyExc_ImportError,
                            "__import__ not found");
            break;
        }
        Py_INCREF(x);

        // 打包参数
        v = POP();
        u = TOP();
        if (PyInt_AsLong(u) != -1 || PyErr_Occurred())
            w = PyTuple_Pack(5,
                        w,
                        f->f_globals,
                        f->f_locals == NULL ?
                              Py_None : f->f_locals,
                        v,
                        u);
        else
            w = PyTuple_Pack(4,
                        w,
                        f->f_globals,
                        f->f_locals == NULL ?
                              Py_None : f->f_locals,
                        v);
        Py_DECREF(v);
        Py_DECREF(u);
        if (w == NULL) {
            u = POP();
            Py_DECREF(x);
            x = NULL;
            break;
        }
        READ_TIMESTAMP(intr0);

        // 调用__import__函数
        // __import__(name, globals={}, locals={}, fromlist=[], level=-1) -> module
        v = x;
        x = PyEval_CallObject(v, w);
        Py_DECREF(v);
        READ_TIMESTAMP(intr1);
        Py_DECREF(w);
        SET_TOP(x);
        if (x != NULL) continue;
        break;

    Python/bltinmodule.c
    ====================

    static PyMethodDef builtin_methods[] = {
        {"__import__",      (PyCFunction)builtin___import__, METH_VARARGS | METH_KEYWORDS, import_doc},
        ...
    };

    static PyObject *
    builtin___import__(PyObject *self, PyObject *args, PyObject *kwds)
    {
        static char *kwlist[] = {"name", "globals", "locals", "fromlist",
                                 "level", 0};
        char *name;
        PyObject *globals = NULL;
        PyObject *locals = NULL;
        PyObject *fromlist = NULL;
        int level = -1;

        if (!PyArg_ParseTupleAndKeywords(args, kwds, "s|OOOi:__import__",
                        kwlist, &name, &globals, &locals, &fromlist, &level))
            return NULL;

        // ok，import模块的入口
        return PyImport_ImportModuleLevel(name, globals, locals,
                                          fromlist, level);
    }

    Python/import.c
    =================

    PyObject *
    PyImport_ImportModuleLevel(char *name, PyObject *globals, PyObject *locals,
                             PyObject *fromlist, int level)
    {
        PyObject *result;
        _PyImport_AcquireLock();

        // 好吧，这个才是最终的入口
        result = import_module_level(name, globals, locals, fromlist, level);
        if (_PyImport_ReleaseLock() < 0) {
            Py_XDECREF(result);
            PyErr_SetString(PyExc_RuntimeError,
                            "not holding the import lock");
            return NULL;
        }
        return result;
    }

    static PyObject *
    import_module_level(char *name, PyObject *globals, PyObject *locals,
                        PyObject *fromlist, int level)
    {
        char buf[MAXPATHLEN+1];
        Py_ssize_t buflen = 0;
        PyObject *parent, *head, *next, *tail;

        if (strchr(name, '/') != NULL
    #ifdef MS_WINDOWS
            || strchr(name, '\\') != NULL
    #endif
            ) {
            PyErr_SetString(PyExc_ImportError,
                            "Import by filename is not supported.");
            return NULL;
        }

        // 获取import语句所在的package
        parent = get_parent(globals, buf, &buflen, level);
        if (parent == NULL)
            return NULL;

        head = load_next(parent, level < 0 ? Py_None : parent, &name, buf,
                            &buflen);
        if (head == NULL)
            return NULL;

        tail = head;
        Py_INCREF(tail);
        while (name) {
            next = load_next(tail, tail, &name, buf, &buflen);
            Py_DECREF(tail);
            if (next == NULL) {
                Py_DECREF(head);
                return NULL;
            }
            tail = next;
        }
        if (tail == Py_None) {
            /* If tail is Py_None, both get_parent and load_next found
               an empty module name: someone called __import__("") or
               doctored faulty bytecode */
            Py_DECREF(tail);
            Py_DECREF(head);
            PyErr_SetString(PyExc_ValueError,
                            "Empty module name");
            return NULL;
        }

        if (fromlist != NULL) {
            if (fromlist == Py_None || !PyObject_IsTrue(fromlist))
                fromlist = NULL;
        }

        if (fromlist == NULL) {
            Py_DECREF(tail);
            return head;
        }

        Py_DECREF(head);
        if (!ensure_fromlist(tail, fromlist, buf, buflen, 0)) {
            Py_DECREF(tail);
            return NULL;
        }

        return tail;
    }

reload一个模块会复用已经载入的该模块的md_dict。对于pure python的模块，如果要干净
的reload，可以先将该模块从sys.modules中删除。当然这个对于builtin和c module是无效
的。 ::


    $ cat foo.py
    a = 1
    b = 2

    print 'foo'

    >>> import foo
    foo
    >>> dir(foo)
    ['__builtins__', '__doc__', '__file__', '__name__', '__package__', 'a', 'b']

    $cat foo.py
    a = 1
    c = 2

    print 'foo'

    >>> reload(foo)
    foo
    <module 'foo' from 'foo.py'>
    >>> dir(foo)
    ['__builtins__', '__doc__', '__file__', '__name__', '__package__', 'a', 'b', 'c']

    >>> import sys
    >>> del sys.modules['foo']
    >>> import foo
    foo
    >>> dir(foo)
    ['__builtins__', '__doc__', '__file__', '__name__', '__package__', 'a', 'c']

