Python环境构建
================

Python编译相关
--------------

动态扩展加载： HAVE_DYNAMIC_LOADING

添加package到标准库，也就是在Lib目录下建子目录需要修改Makefile.pre.in。
将目录路径添加到LIBSUBDIRS变量中。

1.  Python代码中调用Python函数。

2.  Python代码中调用C函数。

3.  C代码中调用Python函数。 ::

        struct wrapperbase {
            char *name;
            int offset;
            void *function;
            wrapperfunc wrapper;
            char *doc;
            int flags;
            PyObject *name_strobj;
        };
        typedef struct wrapperbase slotdef;


设置断点
import pdb; pdb.set_trace()

raise

distutils
----------

export DISTUTILS_DEBUG=1

http://www.ibm.com/developerworks/linux/library/l-dynamic-libraries/

http://tldp.org/HOWTO/Program-Library-HOWTO/shared-libraries.html

PYTHONHOME: Change the location of the standard Python libraries.
PYTHONPATH: 这个变量会prepend到sys.path中。

http://docs.python.org/using/cmdline.html#environment-variables

--enable-shared

对于--enable-shared编译出来的python executable，其运行时需要知道：

1.  python2.6.so的位置。

    python excutable里只有一个main函数，只是一个空壳，负责调用Py_Main。真正的入
    Py_Main在python2.6.so里。

    $ echo $prefix > ld.so.conf.d/python$version.so.conf

2.  标准库的位置。

    默认为os.path.join(sys.prefix, 'lib/python<version>')

::

    >>> import pprint
    >>> import dist.sysconfig
    >>> pprint.pprint(dist.sysconfig.get_config_vars())
 
这些sysconfig是从$prefix/lib/python$version/config/下的Makefile等中解析出来的。

Python/sysmodule.c -> sys module
Modules/getpath.c中的caculate_path函数。
$prefix/lib/python$version/site.py


如何使用setuptools为阉割版（无法import subprocess）的python安装包？

::

    xpython
    =============
    #!/path/to/nornmal/python

    SAE_PYTHON_PREFIX = '目标python的sys.prefix'

    distutils.sysconfig.PREFIX = SAE_PYTHON_PREFIX
    distutils.sysconfig.EXEC_PREFIX = SAE_PYTHON_PREFIX

    # Default installation place
    sys.prefix = SAE_PYTHON_PREFIX
    sys.exec_prefix = SAE_PYTHON_PREFIX

    # some package use these variable
    sys.path[0] = os.getcwd()
    __file__ = os.path.abspath(sys.argv[1])

    import pprint
    pprint.pprint(distutils.sysconfig.get_config_vars())

    # Pop current script name
    sys.argv.pop(0)

    execfile(sys.argv[0])


最后执行xpython setup.py install搞定！

上面执行xpython用的正常版的python最好是静态编译，省很多事阿。
