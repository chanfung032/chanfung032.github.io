Kafka的存储机制
==================

原文：https://thehoard.blog/how-kafkas-storage-internals-work-3a29b02e026

.. code-block:: console

    $ bin/kafka-topics.sh --create --zookeeper localhost:2181 --replication-factor 1 --partitions 3 --topic test --config retention.ms=172800000

每个 topic 由一个或多个分区（ partition ）组成，每个分区都是一个有序消息序列，该序列只能追加不能修改。分区是不可切割的整体，不会再切割后存在多台机器或者多个磁盘上。

.. image:: images/kafka-partition.png

topic创建的时候一般都会指定里面消息的保留策略（ retention policy ），因此 Kafka 会定期清除每个分区（也就是 topic ）下的过期消息，如果一个分区就是一个大文件的话，那每次清除的过程会非常的耗时，所以分区会切分为 segments 后再保存。

.. image:: images/kafka-segment.png

下面是 Kafka 数据目录的结构，顶层目录下每个目录为一个分区。

.. code-block:: console

    $ tree /data0/kafka | head -n 6
    kafka
    ├── test
    │ ├── 00000000003064504069.index
    │ ├── 00000000003064504069.log
    │ ├── 00000000003065011416.index
    │ ├── 00000000003065011416.log

分区目录下为 segement 文件。``*.index`` 是索引文件，``*.log`` 是实际存储每个 segment 里消息的文件，文件名中的数字是该segment 中消息的 base offset，这个 offset 大于上一个 segment 里最后一条消息的offset，小于等于本 segment 文件里第一条的 offset。

每个 segment 文件里为一条一条追加的消息。每条消息由 offset, key, message size, compression codec, crc, version, value 等组成。

我们可以使用 Kafka 自带的工具看下 ``*.log`` 文件里的内容：

.. code-block:: console

    $ bin/kafka-run-class.sh kafka.tools.DumpLogSegments --deep-iteration --print-data-log --files /data/kafka/events-1/00000000003065011416.log | head -n 4
    Dumping /data/kafka/appusers-1/00000000003065011416.log
    Starting offset: 3065011416
    offset: 3065011416 position: 0 isvalid: true payloadsize: 2820 magic: 1 compresscodec: NoCompressionCodec crc: 811055132 payload: {"name": "Travis", msg: "Hey, what's up?"}
    offset: 3065011417 position: 1779 isvalid: true payloadsize: 2244 magic: 1 compresscodec: NoCompressionCodec crc: 151590202 payload: {"name": "Wale", msg: "Starving."}

*.index 文件中每 8 个字节为一条索引，每条索引里存储了 2 个数值：消息的 offset（4 字节）、消息在 segment 文件中的偏移地址（4 字节）。这里消息的 offset 是相对地址，加上文件名里的 base offset 才是消息的实际 offset。

所以知道了消息的 offset，根据 segment 的文件名我们能大致找出这条消息在哪一个 segment 文件中，然后根据消息的 offset 在索引文件中找到最接近这个 offset 并且小于等于这个 offset 的消息的索引（索引文件是有序的，可以二分查找），然后在 segment 文件中找到该索引的偏移地址，依次往后查找就可以找到对应 offset 的消息了。

producer 发送的消息格式 == segment 文件里存储的消息格式 == 发送给 consumer 的消息格式。所以消息传输和保存的过程都不需要转换格式。Kafka 也就可以使用 sendfile 直接发送消息给 consumer。


