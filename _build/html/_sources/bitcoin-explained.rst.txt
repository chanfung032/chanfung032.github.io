Bitcoin Explained
=======================

区块链
-----------

区块链（blockchain）是一个分布式强一致性但是写入性能极其低下的数据库。这个数据库中有且仅有一张区块（block）表，每个区块是这张表里的一条记录（Row）。区块里记录了比特币的交易（Transaction）信息。这张表只能插入新的数据，不能更改。

区块表的表结构如下：

.. code-block:: sql

    create table blocks (
        hash char(32),         -- 区块的 hash
        version int,           -- 区块链协议的版本
        prev_block char(32),   -- 前一个区块的 hash
        merkle_root char(32),  -- 交易信息的 hash
        timestamp int,         -- 时间戳
        bits int,              -- target
        nonce int,
        transaction_count int, -- 交易条数
        transactions text      -- 交易的详细信息
    )

每个区块里保存了上一个区块的 hash 值，也就是指向上一个区块的指针，所有的区块会串成一个链，这也是区块链这个名字的由来。

使用比特币的用户需要加入比特币网络成为其中的一个节点，每个节点上都保存了一份完整的一模一样的区块链副本。

每个节点的角色是对等的，所有的节点既是区块链这个数据库的主，也是从。某个节点插入了一个新的区块之后（这个时候它就是主），会将插入的区块广播给其它的节点，其它节点收到广播后会将这条新的区块插入自己的区块链中，保证所有节点上区块链的同步。这个机制能够工作的前提是插入的时候需要有一个全局锁，保证全局唯一插入，否则很快各个节点的数据库副本之间就会出现大量的冲突。

对于区块链这样的分布式数据库来说，实现一个全局锁是不现实的，所以其采用了一个迂回的方式实现了类似于全局锁的效果，从而保证所有节点上数据的强一致性。这个方式就是将插入新的区块变得非常非常…… 非常的困难。

所有插入的区块需要保证其 hash 小于一个 target。这个 target 由以下公式得出：

.. code-block:: python

    target_max = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
    # 比特币网络有一个全局参数 difficulty
    # https://blockexplorer.com/api/status?q=getDifficulty
    # 随着区块的增加，difficulty 会跟着增加。
    # 随着 difficulty 的增加，target 前面的 0 会越来越多。
    # 也就是说区块的 hash 前面需要有越多的 0。
    # https://en.bitcoin.it/wiki/Difficulty
    target = target_max / difficulty
    bits = target_2_bits(target)

直观来说，就是要让区块的 hash 值的前面出现足够多的 0。我们可以通过修改 nonce, timestamp, transactions 的方式来调整区块的 hash 值，让其满足这个条件，这个计算需要花费大量的 cpu 资源，所以这个计算过程也叫挖矿（Mine），目前这个计算大概需要花费 10 分钟的时间（所以区块链这个数据库的写入速率大概是 1 block／10 min）。

下面是一个最简单的挖矿脚本：

.. code-block:: python

    nonce = 0
    while True:
        hash = sha256(version + prev_block + merkle_root + timestamp + bits + nonce)
        if hash < target:
            break
        nonce += 1

挖出新区块的节点会获得一定的比特币作为回报。所有的从节点在收到新区块的广播后，会计算这个区块是否是合法的（这个计算很简单），如果是才会将其插入到本地的区块链中。

如果有多个节点同时挖出了新的区块，那么区块链就会出现一个分叉，怎么解决这个冲突呢？目前的策略是：如果区块链有分叉，将看哪个分支在分叉点后面，先达到 6 个新区块（称为 "六次确认"）。按照 10 分钟一个区块计算，1 小时就可以确认。

----

一个实际的区块 `区块 #100000 <https://blockexplorer.com/block/000000000003ba27aa200b1cecaad478d2b00432346c3f1f3986da1afd33e506>`_ ：

.. code-block:: python

    >>> def bits_2_target(bits):
    ...     exp = bits >> 24
    ...     mant = bits & 0xffffff
    ...     return mant * (2 ** (8*(exp - 3)))
    >>> target = bits_2_target(0x1b04864c)
    >>> print '%064x' % target
    000000000004864c000000000000000000000000000000000000000000000000
    >>> target_max = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
    >>> difficulty = target_max / float(target)
    >>> print difficulty
    14484.162361225399
    >>> hash = 0x000000000003ba27aa200b1cecaad478d2b00432346c3f1f3986da1afd33e506
    >>> print hash < target
    True

区块中并不存 difficulty ，区块页面里显示的 difficulty 是计算出来的。

比特币
-------------

区块链中存储了比特币从开始到现在所有用户的所有交易记录。一个用户的比特币就是这些交易记录里和其相关的记录。比特币的交易过程就是引用这些已有交易记录来创建新的交易记录并插入区块链的过程。

下面我们以 Alice 交易比特币给 Bob 为例来说明比特币的工作原理。

首先，比特币使用公钥私钥来标示和验证用户，比特币地址是用户的公钥 hash 后使用 base58check（base58check 编码类似于 base64 编码，只是去除了 O, 0, I, l 这些易混淆的字符并添加了一个 4-byte 的校验码，因为交易给错误地址的比特币就永久消失了） 编码出来的。

.. code-block:: python

    address = base58check(version + ripemd160(sha256(pubkey))

Alice 在交易前需要：

1. 知道 Bob 的比特币地址。
2. 在区块链中找到一条别人交易比特币给她的交易记录，这些比特币必须还没交易给给别人。

然后构造下面一条交易记录信息：

.. code-block:: python

    {
        # 本次交易信息的 hash
        "hash": "fff2....02c4",
        "input": [
            {
                # 引用的交易记录的 hash
                "prev_output_hash": "fe02....19a4",
                # 要使用引用的交易记录 output 中的第几项，交易记录的 output 可以有多个
                "prev_output_index": 0,
            }
        ],
        "output": [
            {
                # 交易的比特币数
                "value": "0.31900000",
                # Bob 的比特币地址
                "address": "1JqDybm2nWTENrHvMyafbSXXtTk5Uv5QAn",
            }
        ],
        # Alice 的公钥
        "pubkey": "0987....45af",
        # 使用 Alice 的私钥对消息的签名。
        "sig": "ab0c....efge",
    }

.. image:: images/bitcoin-transaction.png

构造完消息后，Alice 可以通过自己挖矿的方式将这条记录插入区块链中完成交易，但是大部分普通用户的计算资源有效，并没有挖矿的能力，所以普通用户一般会将这条交易信息广播到比特币网络中，让那些专门挖矿的矿工来做挖矿的工作。

假设 Alice 使用 tx 消息将这个交易的信息发送给比特币网络。所有收到消息的节点会验证这条交易信息是否合法：

1. 使用公钥验证签名是否正确，也就是说这条消息是否确实是 Alice 发的（签名是使用私钥签发的，没有私钥无法伪造）。
2. Alice 的公钥是否和引用的交易记录的 ouput 项的 address 是否匹配，也就是说引用的交易记录的 ouput 项是否确实是交易给 Alice 的。
3. 引用的交易记录的 ouput 项是否有交易给其它人的记录，防止 Alice double-spending 这笔比特币。

如果合法，节点会将这条交易信息继续广播下去，比特币网络中的挖矿节点在收到这条交易信息后，会将其加入未完成交易列表中，然后尝试组合这些交易、调整 nonce 等方法来挖出新的区块，一旦 Alice 的交易信息被包含在新的区块中插入了区块链，这个交易就完成了。

btw. 区块链的从节点在收到新的区块后， 也会验证交易的信息是否合法，如果区块合法但是交易不合法，这个区块也会被拒绝。

p.s.

1. 每个引用的交易记录中的 ouput 项只能使用一次，如果钱有多余，可以在新交易信息的 output 里添加自己的 address，将多余的钱交易给自己。
2. 比特币有两种来源，一种是原始发行的，比如 `区块 #1 <https://blockexplorer.com/block/00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048>`_ 中的交易，另外一种是挖矿挖出来的，比如 `区块 #100000 <https://blockexplorer.com/block/000000000003ba27aa200b1cecaad478d2b00432346c3f1f3986da1afd33e506>`_ 中的第一个交易，一般区块里第一个交易记录都是给挖矿的矿工的回报的交易记录。这两类交易记录都是没有 input 的。

参考资料：

- `Bitcoins the hard way: Using the raw Bitcoin protocol <http://www.righto.com/2014/02/bitcoins-hard-way-using-raw-bitcoin.html>`_ 手工创建一个比特币交易（Python 代码）。
- `Bitcoin mining the hard way: the algorithms, protocols, and bytes <http://www.righto.com/2014/02/bitcoin-mining-hard-way-algorithms.html>`_ 挖矿相关的计算细节。
- `How the Bitcoin protocol actually works <http://www.michaelnielsen.org/ddi/how-the-bitcoin-protocol-actually-works/>`_ 如何从零构建出比特币。
- https://en.bitcoin.it/wiki/Help:Introduction
- https://en.bitcoin.it/wiki/Protocol_documentation
