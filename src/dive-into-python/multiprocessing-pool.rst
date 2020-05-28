multiprocessing.Pool 详解
=========================================

创建
---------

.. code-block:: python

    from multiprocessing import Pool
    pool = Pool(4)

创建 worker pool 一般只需指定 worker processes 的数目即可。

apply*
-----------------------

.. function:: apply_async(func[, args[, kwds]])

.. function:: apply(func[, args[, kwds]])

apply_async 将任务提交后立即返回一个 result 对象，不阻塞，后续程序调用 ``result.get()`` 来阻塞获取执行的结果。

.. code-block::  python

    r1 = pool.apply_async(func1, args1, kws1)
    r2 = pool.apply_async(func2, args2, kws2)
    print r1.get()
    print r2.get()

apply 就是 ``apply_async(...).get()`` 添加任务并立即阻塞等待结果。一般不会直接使用这个函数。

map*
-----------

.. function:: map(func, iterable[, chunksize])

.. function:: map_async(func, iterable[, chunksize])

.. function:: starmap(func, iterable[, chunksize])

.. function:: starmap_async(func, iterable[, chunksize])

首先，map 系列函数基本都有一个可选的 chunksize 参数，map 系列函数并不是一个一个迭代 iterable 发给 worker pool 去处理，而是将 iterable 按照 chunksize 切成一个一个的 chunk 然后再发给 worker pool 去处理。这样可以减少和 worker process 的交互，加快任务的执行速度。

.. code-block:: python

    task_batches = Pool._get_tasks(func, iterable, chunksize)

    @staticmethod
    def _get_tasks(func, it, size):
        it = iter(it)
        while 1:
            x = tuple(itertools.islice(it, size))
            if not x:
                return
            yield (func, x)

map 就是 ``map_async(...).get()`` ， starmap 就是 ``starmap_async(...).get()`` 。

map 和 starmap 的区别就是 map 传给 func 的只能是一个参数，而 starmap 可以多个参数。当然 map 也可以将多个参数打包到 tuple 中再传给 func。

.. code-block:: python

    def func_a(x):
        return x*x
    def func_b(x, y):
        return x*y

    p.map(func_a, range(10))
    p.starmap(func_b, ((i,i) for i in range(10)))

.. function:: imap(func, iterable[, chunksize])

.. function:: imap_unordered(func, iterable[, chunksize])

imap 和 map 不一样的地方在于，map 是先执行了 ``list(iterable)`` 然后再将任务分 chunk 提交给 worker pool，而 imap 一次只会 ``list()`` 一个 chunk，并且默认 chunksize 为 1。如果 ``list(iterable)`` 要消耗大量的内存，可以考虑使用 imap 函数。一般 imap 比 map 慢。

imap 和 map 另外一个不一样的地方是 imap 函数返回的结果是一个迭代器，这样每个 func 执行完后可以立即获得执行结果，而不是像 map 要到所有全部执行完毕才能获得结果。

imap 和 imap_unordered 不一样的地方在于一个是按输入参数 iterable 的顺序返回结果的，一个是按任务的完成先后返回结果的。

参考：

- https://github.com/python/cpython/blob/2.7/Lib/multiprocessing/pool.py
- https://stackoverflow.com/questions/26520781/multiprocessing-pool-whats-the-difference-between-map-async-and-imap/26521507#26521507
