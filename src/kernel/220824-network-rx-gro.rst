#220824 网络栈接收数据 RX | GRO
===========================================

INDIRECT_CALL_* 宏的作用是什么
-------------------------------------

https://elixir.bootlin.com/linux/latest/source/include/linux/indirect_call_wrapper.h

.. code-block:: c

  INDIRECT_CALL_INET(ptype->callbacks.gro_complete,
    ipv6_gro_complete, inet_gro_complete, skb, 0);

宏展开之后就是：

.. code-block:: c

  likely(ptype->callbacks.gro_complete == inet_gro_complete)?
    inet_gro_complete(skb, 0)
    :
    (likely(ptype->callbacks.gro_complete == ipv6_gro_complete)?
      ipv6_gro_complete(skb, 0)
      :
      ptype->callbacks.gro_complete(skb, 0));

功能就是猜某个函数指针指向的是哪个函数，如果是某几个已知函数，那就直接调用这些函数，而不是通过函数指针。因为 **直接调用函数比通过函数指针调用的性能要好** 。这个具体可以参见：https://lwn.net/Articles/774743/，大体说来就是：

| 因为函数指针调用（indirect function call）性能不行，所以 CPU 进化出了 indirect branch predictor。
| 因为有了 indirect branch predictor，所有有了 `Spectre <https://en.wikipedia.org/wiki/Spectre_(security_vulnerability)>`_ （幽灵👻） 这类针对它的侧信道攻击，呜呜呜，predictor 不能用了。
| 因为 predictor 不能用了，所以有了 `retpoline <https://support.google.com/faqs/answer/7625886>`_ 这个 hack。retpoline 解决了问题又没有彻底解决。
| 通过函数指针调用性能不行，那就用想个办法直接调函数，不用指针？于是就有了 ``INDIRECT_CALL_*`` 宏。

从 napi_gro_receive 到 netif_receive_skb
------------------------------------------

GRO 全称 Generic Receive Offload，是 Linux 网络栈里收包侧的一个软件优化，功能就是将网卡收到的一堆 mtu 1500 的小包给合并为大包再交给上层协议栈去处理。GRO 位于 tcpdump 等抓包工具的挂载点之前，所以抓包工具看到的 GRO 之后的大包。

.. image:: images/gro.svg

调用栈： ::

    napi_gro_receive(napi, skb)
      |- gro_result = dev_gro_receive(napi, skb)
      |  |- bucket = skb_get_hash_raw(skb)
      |  |- gro_list = &napi->gro_hash[bucket]
      |  |
      |  |- if netif_elide_gro(skb->dev)
      |  |    return GRO_NORMAL
      |  |
      |  |- gro_list_prepare(&gro_list->list, skb)
      |  |
      |  |- pp = ptype->callbacks.gro_receive/inet_gro_receive
      |  |    |- tcp4_gro_receive
      |  |      |- tcp_gro_receive
      |  |        |- skb_gro_receive
      |  |
      |  |- if pp:
      |  |    |- napi_gro_complete
      |  |      |- ptype->callbacks.gro_complete/inet_gro_complete
      |  |      | |- tcp4_gro_complete
      |  |      |- gro_normal_one 👈
      |  |
      |  |- if NAPI_GRO_CB(skb)->same_flow
      |  |    return GRO_MERGED_FREE
      |  |
      |  |- list_add(&skb->list, &gro_list->list)
      |  |- return GRO_HELD
      |
      |- napi_skb_finish(napi, skb, gro_result)
         |- switch gro_result
         |- case GRO_NORMAL: gro_normal_one(napi, skb, 1) 👈
         |- case GRO_MERGED_FREE: __kfree_skb(skb)
         |- default: return

（GRO 合并包这个函数比较复杂，这里我们只是要大致理清其脉络，所以上面的调用栈经过了一定的简化）

``napi_gro_receive`` 的输入是驱动从网卡 ring buffer 收获并构建出的一个个 skb 结构体，要合并就得缓存，GRO 模块会将收到的 skb 缓存到 ``napi->gro_hash`` 中，这是一个大小为 8 的数组，每个元素又分别是个 skb 列表。

.. code-block:: c

    struct napi_struct {
      //...
      #define GRO_HASH_BUCKETS	8
      struct gro_list gro_hash[GRO_HASH_BUCKETS]
      //...
    }

缓存和合并完成继续往上发送包的逻辑如下：

1. 首先，调用 ``skb_get_hash_raw`` 获取包的 hash（这个 hash 是驱动从 ring buffer 收包的时候直接从包的 metadata 中获取到并调用 ``skb_set_hash`` 设置的，也就是网卡直接提供了的），GRO 模块将相同 hash 的 skb 缓存到同一个列表中。 ``napi->gro_hash[bucket]`` 获取到缓存 skb 列表，这里面可能有和新到来的 skb 属于同一个流的 skb。
2. 调用 ``netif_elide_gro`` 检查要不要做 GRO，不做的话直接跳过 GRO 处理。调用 ``napi_skb_finish``，最终调用 ``gro_normal_one`` 将包继续往上层传。
3. 如果需要做 GRO，则调用 ``gro_list_prepare`` 对比新来的 skb 和 缓存 skb 列表里的每一个 skb 的 L2 协议头（mac header）是否一致，给缓存列表中对比一致的 skb 设置 ``NAPI_GRO_CB(skb)->same_flow = 1`` 标示其可能和新来的 skb 是一个流的。
4. 根据上层协议逐级往上调用上面协议层的 ``gro_receive`` 函数，比如一个 TCP 包会依次调用 ``inet_gro_receive`` -> ``tcp_gro_receive`` 函数，每一个协议层中会根据自己这一层的 header 继续过滤缓存 skb 列表中可能是同一个流的 skb。最终如果找到同一个流的 skb 缓存。调用 ``skb_gro_receive`` 合并包。
5. ``gro_receive`` 函数最终会返回一个指针，如果不为空，说明有合并后的 skb 需要往上层送了，这个时候需要级联调用 ``gro_complete`` 函数更新每层协议头中的一些字段（比如 checksum），完成后，调用 ``gro_normal_one`` 将包继续往上层传。
6. 包被合并后对应的 skb 会在 ``napi_skb_finish`` 中被释放掉。
7. 如果没有找到同一个流的 skb，新的 skb 会被添加到缓存 skb 列表中。

skb 合并的方法是将 **新 skb 的线性数据和非线性数据** 合并到 **老 skb 的非线性数据区** 中。合并的时候优先使用 ``skb_shared_info->frags`` 数组（新 skb 的线性区如果是页直接映射的，也可以直接合并到里面，详细见：   `net: make GRO aware of skb->head_frag <https://github.com/torvalds/linux/commit/d7e8883cfcf4851afe74fb380cc62b7fa9cf66ba>`_ )，放不下之后再 fallback 使用 ``skb_shared_info->frag_list`` （可以参见前面 skb 文中 :ref:`nonlinear-skb` 第一种和第二种结构）。新 skb 的各种协议头会被 ``skb_pull`` 到只剩下数据。

``gro_normal_one`` 函数中， skb 会被保存到 ``napi->rx_list`` 列表中，当列表长度超过阈值 ``gro_normal_batch`` 时，调用 ``gro_normal_list`` 批量将 skb 往上层送。 从 ``netif_receive_skb_list_internal`` 开始 skb 就算出了 GRO 模块了开始协议栈投递了。 ::

    gro_normal_one
      |- gro_normal_list
        |- netif_receive_skb_list_internal
          |- __netif_receive_skb_list
            |- __netif_receive_skb_list_core
              |- __netif_receive_skb_core
                |- deliver_skb

References:

- https://lwn.net/Articles/358910/
- https://blog.csdn.net/zgy666/article/details/106989856
- http://arthurchiao.art/blog/linux-net-stack-implementation-rx-zh/#66-napi_gro_receive
