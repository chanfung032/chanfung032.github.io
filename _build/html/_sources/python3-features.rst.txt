一些 Python 3 新特性及其使用方法
================================

Python 2 转 3 的流水账。

https://docs.python.org/3/whatsnew/index.html

2to3
------------

- ``print`` 在 3 中是一个 function。 ::

    >>> print 'hello'
    File "<stdin>", line 1
        print 'hello'
                    ^
    SyntaxError: Missing parentheses in call to 'print'. Did you mean print('hello')?
    >>> print('hello')
    hello

- ``StringIO``、``cStringIO`` 模块删除，对应的功能由 ``io.StringIO``、``io.BytesIO`` 取代。
- ``super()`` 函数可以不用传参数了。 ::

    # Python 2
    class MySubClass(MySuperClass):
        def __init__(self):
            super(MySubClass, self).__init__()

    # Python 3
    class MySubClass(MySuperClass):
        def __init__(self):
            super().__init__()

- ``3/2`` 现在返回一个 float，而不是 2 中的 int。
- ``dict.keys()``, ``dict.items()``, ``dict.values()`` 现在返回 views 而不是 lists。iter\* 系列函数被删除。
- ``map()``、``filter()``、``range()``、``zip()`` 现在返回 iterator。

Literal String Interpolation
---------------------------------

又叫 f-string，用来替代 % 格式化、 ``str.format()`` 格式化。基本语法如下： ::

    f ' <text> { <expression> <optional !s, !r, or !a> <optional : format specifier> } <text> ... '

其中

- ``!s``, ``!r``, ``!a`` 等于 ``str(expression)``, ``repr(expression)``, ``ascii(expression)`` 。
- format specifier 同 ``format()`` 的，详细见：https://docs.python.org/3.7/library/string.html#formatspec

示例： ::

    >>> name = 'world'
    >>> f'hello {name}'
    'hello world'
    >>> f'hello {name.upper()}'
    'hello WORLD'
    >>> f'hello {name!r}
    "hello 'world'"
    >>> f'hello {{name}}'
    "hello {name}'
    >>> f'hello {name:10s}'
    'hello world     '

- https://www.python.org/dev/peps/pep-0498/#specification

Fine-grained OS Exceptions
------------------------------

::

    >>> open('/sbin/md5', 'w')
    Traceback (most recent call last):
    File "<stdin>", line 1, in <module>
    PermissionError: [Errno 1] Operation not permitted: '/sbin/md5'
    >>> PermissionError.mro()
    [<class 'PermissionError'>, <class 'OSError'>, <class 'Exception'>, <class 'BaseException'>, <class 'object'>]

``OSError`` 根据 errno 的不一样有了一系列的子异常，可以直接捕获这些异常而不是如下捕获 OSError 后再判断其 errno。 ::

    try:
        open('/sbin/md5', 'w')
    except OSError as e:
        if e.errno in [errno.EPERM, errno.EACCES]:
            pass

https://docs.python.org/3/library/exceptions.html#os-exceptions

Extended Iterable Unpacking
------------------------------

::

    >>> first, *rest, last = seq
    >>> first, rest, last
    (0, [1, 2, 3], 4)

https://www.python.org/dev/peps/pep-3132/

faulthandler
---------------

给 SIGSEGV，SIGFPE，SIGABRT，SIGBUS 或者 SIGILL 安装 handler，在遇到这些信号程序挂的时候打印当时的调用栈。

::

    import faulthandler
    faulthandler.enable()

    def killme():
        import sys
        from ctypes import CDLL
        dll = 'dylib' if sys.platform == 'darwin' else 'so.6'
        libc = CDLL("libc.%s" % dll)
        libc.time(-1)  # BOOM!!

    killme()

.. code-block:: shell

    $ python test.py
    Fatal Python error: Segmentation fault

    Current thread 0x00007fff781b6310:
    File "test.py", line 11 in killme
    File "test.py", line 13 in <module>
    Segmentation fault: 11

也可以通过设置 ``PYTHONFAULTHANDLER=1`` 环境变量或者命令行参数 ``-X faulthandler`` enable 这个 handler。

https://docs.python.org/3/library/faulthandler.html

Exception Chaining
--------------------

::

    >>> try:
    ...     1/0
    ... except ZeroDivisionError:
    ...     raise RuntimeError()
    ...
    Traceback (most recent call last):
    File "<stdin>", line 2, in <module>
    ZeroDivisionError: division by zero

    During handling of the above exception, another exception occurred:

    Traceback (most recent call last):
    File "<stdin>", line 4, in <module>
    RuntimeError

如果不想输出整个 Exception chain，可以使用 ``raise RuntimeError() from None`` 。

https://www.python.org/dev/peps/pep-3134/

Enum
---------

::

    from enum import Enum
    class Color(Enum):
        RED = 1
        GREEN = 2
        BLUE = 3

Thousands Separator
-----------------------

::

    >>> f'{100000000000:,d}'
    '100,000,000,000'
    >>> 100_000_000_000
    100000000000

cocurrent.future
---------------------

在 threading 和 multiprocessing 之上的一层抽象。

基本使用： ::

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        future = executor.submit(fn, args, kwargs)
        print(future.result())

同 map 函数，只是任务会并发执行： ::

    with concurrent.futures.ProcessPoolExecutor() as executor:
        for result executor.map(fn, iterables)):
            print(result)

并发执行，按任务完成的顺序返回结果： ::

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(fn, i) for i in iterables]
        for future in concurrent.futures.as_completed(futures):
            try:
                print(future.result())
            except Exception as exc:
                pass

https://docs.python.org/3/library/concurrent.futures.html

venv
-----------

标准库内置了对 virtual environment 的支持。

.. code-block:: shell

$ python3 -m venv /path/to/new/virtual/environment

Multiple Unpacking
-----------------------

::

    {**a, **b, **c}
    [*a, *b, *c]
    {*a, *b, *c}
    (*a, *b, *c)

另外函数调用也支持多个 unpacking，不再限于以前的一个： ::

    def foo(*args):
        pass
    # 在 2 中报语法错误，在 3 中 OK。
    foo(*[1, 2], *[3])

https://www.python.org/dev/peps/pep-0448/

Keyword-only arguments
---------------------------

使用 ``*`` 号指定其后所有的参数只可以通过 keyword arguments 来传递。  ::

    class SVC(BaseSVC):
        def __init__(self, *, C=1.0, kernel='rbf', degree=3, gamma='auto', coef0=0.0, ... )

https://www.python.org/dev/peps/pep-3102/

pathlib
-------------

::

    >>> from pathlib import Path
    >>> Path('/a') / 'b' / 'c'
    PosixPath('/a/b/c')

ipaddress
-----------------

::

    >>> from ipaddress import ip_address
    >>> ipaddress('1.2.3.4')
    IPv4Address('1.2.3.4')
    >>> ip_address('::')
    IPv6Address('::')
    

