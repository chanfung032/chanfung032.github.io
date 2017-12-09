Go 语言实现——变量
=======================

变量（variable） = 类型（type）+变量名（name）+值（value）。

值（value）的内存结构
---------------------

基础类型 ::

    +---+
    | 1 |  int
    +---+
    +---+
    |3.1|  float32
    +---+
    +---+---+---+---+
    | 1 | 2 | 3 | 4 | [4]int 
    +---+---+---+---+

结构体（struct） ::

    +---+---+---+---+---+---+---+---+
    | 1 | 2 | 0 | 0 | 3 | 0 | 0 | 0 | struct{a byte; b byte; c int32} = {1,2,3} 
    +---+---+---+---+---+---+---+---+
      a   b           c

字符串和切片（slice） [1]_ ::

    +---------+---------+
    | pointer | len=5   | s = "hello"
    +---------+---------+
      |
      +---+---+---+---+---+
      | h | e | l | l | o | [5]byte
      +---+---+---+---+---+
          |
    +---------+---------+
    | pointer | len=2   | sub = s[1:3]
    +---------+---------+

    +---------+---------+---------+
    | pointer | len=8   | cap=8   | x = []int{0,1,2,3,4,5,6,7}
    +---------+---------+---------+
        |
        +---+---+---+---+---+---+---+---+
        | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | [8]int 
        +---+---+---+---+---+---+---+---+
            |       
            +---------+---------+---------+
            | pointer | len=2   | cap=5   | y = x[1:3:6]
            +---------+---------+---------+


从上面可以看出，Go 在存储变量值时和 C 比较类似，就是存的 raw 数据。

那么问题来了，既然变量值里没有保存类型指针之类的额外数据， ``reflect.TypeOf(v)`` 是怎么取得变量值的类型信息的呢？

我们看一下 ``reflect.TypeOf(v)`` 的函数原型：

.. code-block:: go

    func TypeOf(i interface{}) Type

从函数原型来看，答案应该就在这个 *interface{}* 里了 。

接口 interface 的实现
----------------------

interface 是 Go 语言中类型系统的注入点。

根据 interface 是否包含有 method，interface 用  `iface <https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/runtime2.go#L143>`_  和 `eface <https://github.com/golang/go/blob/release-branch.go1.9/src/runtime/runtime2.go#L148>`_ 这两种结构体来保存。eface 是不含 method 的 interface 结构，即 interface{} 。

.. code-block:: go

    type iface struct {
        tab  *itab
        data unsafe.Pointer
    }

    type eface struct {
        _type *_type
        data  unsafe.Pointer
    }

    type itab struct {
        inter  *interfacetype
        _type  *_type
        link   *itab
        hash   uint32 // copy of _type.hash. Used for type switches.
        bad    bool   // type does not implement interface
        inhash bool   // has this itab been added to hash?
        unused [2]byte
        fun    [1]uintptr // variable sized
    }

iface/eface 中的 data 是指向实际值（value）的指针， *itab._type* 或者 *_type* 是指向类型信息的指针，Go 语言在编译的时候会将所有类型信息保存在可执行文件中，在运行时载入内存，最后在创建 interface{} 结构的时候将类型信息注入到 interface{} 结构中。 通过 *s.tab->type* 即可获取值（value）的类型信息。

最后，我们用一段简单的代码看看 interface{} 具体是怎么工作的。

.. code-block:: go

    // test.go
    package main

    func main() {
        s := "ABC"
        var i interface{} = s
        s1 := i.(int)
        print(s1)
    }

编译并打印语法树：

.. code-block:: console

    $ go tool compile -W test.go

语法树比较长，下面是相关部分简化并注释后的输出 ::

    // 还有一个 before walk main 是原始的语法树，after 是 golang 对语法树做了所有修改之后的最终语法树。
    after walk main
        // 声明一个 string 类型的变量 s
    .   DCL
    .   .   NAME-main.s string

        // AS == ASSIGMENT，将 string value "abcd" 赋值给变量 s
    .   AS
    .   .   NAME-main.s string
    .   .   LITERAL-"abcd" string

        // 声明一个 interface{} 类型的变量 i
    .   DCL
    .   .   NAME-main.i INTER-interface {}

        // 将变量 s 赋值给自动生成的临时变量 autotmp_0
    .   AS
    .   .   NAME-main..autotmp_0 string
    .   .   NAME-main.s string

    .   AS-init
            // 将 autotmp_0 赋值 给 autotmp_2
    .   .   AS l(5) tc(1)
    .   .   .   NAME-main..autotmp_2 string
    .   .   .   NAME-main..autotmp_0 string
    .   AS
            // 将（string类型指针，autotmp_2）赋值给变量 i
    .   .   NAME-main.i INTER-interface {}
    .   .   EFACE u(2) l(5) tc(1) INTER-interface {}
    .   .   .   ADDR PTR64-*uint8
    .   .   .   .   NAME-type.string uint8
    .   .   .   ADDR PTR64-*string
    .   .   .   .   NAME-main..autotmp_2 string

    .   VARKILL
    .   .   NAME-main..autotmp_0 string

        // 声明一个新的变量 s1
    .   DCL l(6)
    .   .   NAME-main.s1 int

    .   AS
    .   .   NAME-main..autotmp_1 int

        // 检查 i 的类型是不是 int，是的话赋值给 autotmp_1
    .   AS
    .   .   NAME-main..autotmp_1 int
    .   .   DOTTYPE
    .   .   .   NAME-main.i INTER-interface {}

        // 将 autotmp_1 赋值给 s1
    .   AS
    .   .   NAME-main.s1 int
    .   .   NAME-main..autotmp_1 int

    .   VARKILL l(6) tc(1)
    .   .   NAME-main..autotmp_1 int

参考：

.. [1] https://blog.golang.org/go-slices-usage-and-internals
.. [2] https://research.swtch.com/interfaces
.. [3] http://legendtkl.com/2017/07/01/golang-interface-implement/
.. [4] https://blog.golang.org/laws-of-reflection
.. [5] https://stackoverflow.com/a/34608738
.. [6] https://blog.altoros.com/golang-internals-part-2-diving-into-the-go-compiler.html