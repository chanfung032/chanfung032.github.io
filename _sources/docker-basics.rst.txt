容器——Namespace、AUFS
========================

Namespace
-------------

Namespace 操作主要涉及以下三个 API：

clone(2)
    clone 系统调用创建新进程，通过 ``flags`` 参数指定 ``CLONE_NEW*`` 标识来创建新的 Namespace 并将新创建的进程加入其中。

setn(2)
    允许进程加入已存在的 Namespace。 ``docker exec`` 的实现会用到该系统调用。

unshare(2)
    创建新的 Namespace （通过和 clone 类似的参数）并将调用的进程加入到该 Namespace 中。

http://man7.org/linux/man-pages/man7/namespaces.7.html

.. code-block:: go

	cmd := exec.Command("sh")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: syscall.CLONE_NEWUTS |
            syscall.CLONE_NEWIPC |
            syscall.CLONE_NEWPID |
            syscall.CLONE_NEWNS |
            syscall.CLONE_NEWNET |
            syscall.CLONE_NEWUSER,
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatal(err)
	}

（Go 语言中的 ``exec.Command`` 就是 ``clone + exec`` ，我们可以通过 ``cmd.SysProcAttr`` 来指定 clone 的相关 ``flags`` ）

通过上面的程序，我们创建了一个新的 ``sh`` 进程，这个进程运行在新的 uts, ipc, ... Namespace 中。

UTS
^^^^^^^^

UTS Namespace 主要用来隔离 hostname 和 domainname 这两个系统标识，这样新 Namespace 可以有独立的 hostname。

在新 Namespace 的 sh 中，我们修改 hostname：

.. code-block:: console

    # hostname -b westeros
    # hostname
    westeros

另开一个窗口，打开一个全局 Namespace 的 sh。

    # hostname
    vagrant-ubuntu-trusty-64

可以发现全局的不受影响。

IPC
^^^^^^^^^

IPC Namespace 主要是隔离 System V message queues 等。在新 Namespace 的 sh 中：

.. code-block:: console

    # ipcmk -Q
    Message queue id: 0
    # ipcs
    ...
    ------ Message Queues --------
    key        msqid      owner      perms      used-bytes   messages
    0x618c7bdc 0          root       644        0            0

在全局 sh 中：

.. code-block:: console

    ipcs
    ...
    ------ Message Queues --------
    key        msqid      owner      perms      used-bytes   messages

可以发现全局的不受影响。

PID
^^^^^^^^^^^^^

PID Namespace 用来隔离进程 pid，同一个进程在新 Namespace 和全局的 Namespace 中 pid 不一样，这样新 Namespace 的第一个进程的 pid 就可以为 1。

.. code-block:: console

    # mount -t proc proc /proc
    # pstree
    # pstree -pl
    sh(1)───pstree(4)

Mount
^^^^^^^^^^^^

也就是 ``CLONE_NEWNS``, 隔离挂载点视图，这样新 Namespace 中 mount，umount 就和全局 Namespace 脱钩了。这样新 Namespace 中可以切换 rootfs。

Network
^^^^^^^^^^^^

Network Namespace 是用来隔离网络设备、 IP地址端口等网络栈的 Namespace。Network Namespace 可以让每个容器拥有自己独立的(虚拟的)网络设备，而且容器内的应用可以绑定到自己的端口，每个 Namespace 内的端口都不会互相冲突。在宿主机上搭建网桥后，就能很方便地实现容器之间的通信，而且不同容器上的应用可以使用相同的端口。

默认新 Namespace 中只有一个 lo 设备，具体如何构建网络可以参考 :doc:`docker-network` 。

.. code-block:: console

    # ip a
    1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN group default
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

USER
^^^^^^^^^^^

User Namespace 主要是隔离用户的用户组 ID。 也就是说，一个进程的 uid 和 gid 在User Namespace 内外可以是不同的。 比较常用的是，在宿主机上以一个非 root 用户运行 创建一个 User Namespace， 然后在 User Namespace 里面却映射成 root 用户。这意味着，这个进程在 User Namespace 里面有 root 权限，但是在 User Namespace 外面却没有 root 的权限。

AUFS
---------

.. code-block:: console

    $ mkdir writeLayer
    $ mount -t aufs -o dirs=./writeLayer:./busybox none ./mnt
    $ cd mnt
    $ touch test123
    $ ls ../writeLayer
    test123

AUFS 可以把多个文件夹合并成一个统一的视图，如上面的命令会将 writeLayer 和 busybox 两个文件夹的内容合并到一起并挂载到 mnt 目录下，第一个目录 writeLayer 可读写，其余目录只读。读的内容为 busybox + writeLayer，写的内容会写到 writeLayer 下。

容器的 rootfs 即通过以上方式构建而成。

pivot_root
--------------

    ``pivot_root``  moves  the root file system of the current process to the directory put_old and makes new_root the new root file system

上面新 Namespace 中的进程的 rootfs 还是和系统的一样，我们可以通过 ``pivot_root`` （类似 chroot）将新 Namespace 中的 root方式切换到一个我们通过 AUFS 构建出的文件系统中

自此，一个简陋的容器就构建完成了。

参考资料： `自己动手写Docker <https://github.com/xianlubird/mydocker>`_
