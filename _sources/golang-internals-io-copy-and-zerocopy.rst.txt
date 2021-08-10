Go 语言实现——io.Copy 和 zerocopy 优化
==========================================

``io.Copy`` 系函数对文件和文件之间、文件和 socket 之间的复制做了不少 zerocopy 优化。

.. code-block:: go 

    func Copy(dst Writer, src Reader) (written int64, err error) {
        return copyBuffer(dst, src, nil)
    }

    func copyBuffer(dst Writer, src Reader, buf []byte) (written int64, err error) {
        // If the reader has a WriteTo method, use it to do the copy.
        // Avoids an allocation and a copy.
        if wt, ok := src.(WriterTo); ok {
            return wt.WriteTo(dst)
        }
        // Similarly, if the writer has a ReadFrom method, use it to do the copy.
        if rt, ok := dst.(ReaderFrom); ok {
            return rt.ReadFrom(src)
        }

        // 非 zerocopy 版 copyBuffer
        // ...
    }

如果 src 实现了 WriterTo、 dst 实现了 ReaderFrom 接口，就会走到 zerocopy 路径。dst Writer 实现 ReaderFrom 接口在标准库中见的比较多，以 \*TcpConn 为例：

.. code-block:: go 

    // ReadFrom implements the io.ReaderFrom ReadFrom method.
    func (c *TCPConn) ReadFrom(r io.Reader) (int64, error) {
        if !c.ok() {
            return 0, syscall.EINVAL
        }
        n, err := c.readFrom(r)
        if err != nil && err != io.EOF {
            err = &OpError{Op: "readfrom", Net: c.fd.net, Source: c.fd.laddr, Addr: c.fd.raddr, Err: err}
        }
        return n, err
    }

    func (c *TCPConn) readFrom(r io.Reader) (int64, error) {
        if n, err, handled := splice(c.fd, r); handled {
            return n, err
        }
        if n, err, handled := sendFile(c.fd, r); handled {
            return n, err
        }
        return genericReadFrom(c, r)
    }

TcpConn 会尝试使用 splice 或者 sendfile 等 zerocopy 方法来复制数据，在这两个方法都无法从 src 复制数据的时候，才 fallback 回使用普通的用户空间复制数据方法。

下面是封装的 splice 函数，splice 函数会判断 src Reader 是不是 \*TcpConn ，是的话才会调用 splice 调用。同理 sendfile 也会做类型判断，只有对的类型才会做 zerocopy 优化。

.. code-block:: go

    func splice(c *netFD, r io.Reader) (written int64, err error, handled bool) {
        var remain int64 = 1 << 62 // by default, copy until EOF
        lr, ok := r.(*io.LimitedReader)
        if ok {
            remain, r = lr.N, lr.R
            if remain <= 0 {
                return 0, nil, true
            }
        }

        var s *netFD
        if tc, ok := r.(*TCPConn); ok {
            s = tc.fd
        } else if uc, ok := r.(*UnixConn); ok {
            if uc.fd.net != "unix" {
                return 0, nil, false
            }
            s = uc.fd
        } else {
            return 0, nil, false
        }

        written, handled, sc, err := poll.Splice(&c.pfd, &s.pfd, remain)
        if lr != nil {
            lr.N -= written
        }
        return written, wrapSyscallError(sc, err), handled
    }

完整的代码见：https://go-review.googlesource.com/c/go/+/107715

----

splice 这个系统调用以前没见过，这个系统调用可以用来将一个 fd 的数据在内核中直接复制到另一个 fd 中。过程大致如下：

1. 创建一个 pipe 用来存储要复制的数据的元信息。
2. 调用 splice 将 src fd 要复制数据的元信息写入到管道中。
3. 调用 splice 从 pipe 中获取要复制数据的元信息，然后将数据复制到 dst fd 中。

.. image:: images/splice.png

代码示例：https://github.com/chanfung032/labs/blob/master/splice.c

另外，pipe 这个可以通过池化来减少一次系统调用，增加性能。详细见：https://strikefreedom.top/pipe-pool-for-splice-in-go

参考&延伸：

- https://delveshal.github.io/2018/08/31/zero-copy-transfer/
- https://man7.org/linux/man-pages/man2/splice.2.html
- Notes on using splice(2) from Go https://acln.ro/articles/go-splice