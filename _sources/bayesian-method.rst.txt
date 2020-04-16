贝叶斯方法
===================

推导
---------

根据 `条件独立 <https://zh.wikipedia.org/wiki/%E6%9D%A1%E4%BB%B6%E7%8B%AC%E7%AB%8B>`_ 公式，如果事件 X 和 Y 相互独立，那么：

.. math:: P(X,Y) = P(X)P(Y)

根据 `条件概率 <https://zh.wikipedia.org/wiki/%E6%9D%A1%E4%BB%B6%E6%A6%82%E7%8E%87>`_ 公式：

.. math::

    P(Y|X) = P(X,Y)/P(X) \\
    P(X|Y) = P(X,Y)/P(Y)

综上可得：

.. math:: P(Y|X) = P(X|Y)P(Y)/P(X)

接着，根据 `全概率公式 <https://zh.wikipedia.org/wiki/%E5%85%A8%E6%A6%82%E7%8E%87%E5%85%AC%E5%BC%8F>`_ ：

.. math:: P(X) = \sum\limits_{k}P(X|Y =Y_k)P(Y_k) 其中\sum\limits_{k}P(Y_k)=1

可得出贝叶斯公式如下：

.. math:: P(Y_k|X) = \frac{P(X|Y_k)P(Y_k)}{\sum\limits_{k}P(X|Y =Y_k)P(Y_k)}

朴素贝叶斯分类
---------------

朴素贝叶斯分类器：

.. math:: y = \arg \max_{c_k} P(Y = c_k | X = x)

也就是分类时，对给定的输入 :math:`x`，计算概率分布 :math:`P(Y=c_k | X = x)`，将最大的类 :math:`c_k` 作为 x 的类输出。

.. math::

    \begin{split} P(Y=c_k \ | \ X=x) &= \frac{P(X = x \ | \ Y = c_k) \ P(Y = c_k)}{P(X = x)} \\ 
    &=  \frac{P(X = x \ | \ Y = c_k) \ P(Y = c_k)}{\sum_k P(X = x \ | \ Y = c_k) \ P(Y = c_k)} \\
    &= \frac{P(Y = c_k) \ \prod_j P(X^{(j)}=x^{(j)} | Y = c_k)}{\sum_k P(Y = c_k) \ \prod_j P(X^{(j)}=x^{(j)} | Y = c_k)} \end{split}

在上面的公式中，朴素贝叶斯法对条件概率分布作了条件独立性的假设。由于这是一个较强的假设，朴素贝叶斯法也由此得名，具体地，也就是假设： :math:`P(X = x|Y = c_k) = P(X^{(1)} = x^{(1)},..., X^{(n)} = x^{(n)}|Y=C_k)  = \prod_{j=1}^{n}{P(X^{(j)} = x^{(j)})|Y = C_k})` 。

因为分母对所有 :math:`c_k` 都相同，可以去掉，最终有：

.. math:: y = \arg \max_{c_k} P(Y = c_k) \prod_j P(X^{(j)}=x^{(j)} | Y = c_k)

实际应用：拼写纠正
-------------------

要解决的问题：用户输入了一个不在字典中的单词，猜测这个用户真正想要输入的单词是什么？ 用形式化的语言描述就是：

.. math:: P(我们猜测用户想输入的单词|实际输入的单词)

抽象化标记为：

.. math:: P(c|W)

运用贝叶斯公式，可以得到：

.. math:: P(c|W) = P(c) * P(W|c) / P(W)

对于不同的拼写纠正 :math:`c1` :math:`c2` ...，:math:`P(W)` 都是一样的，所以比较 :math:`P(c1|W)` 和 :math:`P(c2|W)` 的时候可以忽略这个常数，即 

.. math:: P(c|W) \propto P(c) * P(W|c) 

这个式子的抽象含义是：对于给定观测数据，一个猜测是好是坏，取决于“这个猜测本身独立的可能性大小（先验概率，Prior ）”和“这个猜测生成我们观测到的数据的可能性大小”（似然，Likelihood ）的乘积。具体到拼写纠正的例子上，含义就是，用户实际是想输入 the 的可能性大小取决于 the 本身在词汇表中被使用的可能性（频繁程度）大小（先验概率）和 想打 the 却打成 thew 的可能性大小（似然）的乘积。

一个完整的代码（来自 `Peter Norvig - How to Write a Spelling Corrector <http://norvig.com/spell-correct.html>`_ Peter Norvig 是《人工智能：现代方法》的作者之一）：

.. code-block:: python

    import re
    from collections import Counter

    def words(text): return re.findall(r'\w+', text.lower())

    # http://norvig.com/big.txt
    # 由 Project Gutenberg 的一些公版图书拼接而成
    WORDS = Counter(words(open('big.txt').read()))

    def correction(word): 
        """输入一个单词返回最可能的拼写纠正，
         因为 candidates 返回的可选拼写纠正的 P(W|c) 都一样，所以只要比较词频就行了"""
        return max(candidates(word), key=P)

    def candidates(word): 
        """
        按以下优先级返回可选的拼写纠正：
           如果输入单词在词汇表中，直接返回该单词
           如果有相差1个编辑距离的单词在词汇表中，返回这些单词
           如果有相差2个编辑距离的单词在词汇表中，返回这些单词
           返回输入单词（即使其不在词汇表中）
        """
        return (known([word]) or known(edits1(word)) or known(edits2(word)) or [word])

    def P(word, N=sum(WORDS.values())): 
        "词语本身在词汇表中被使用的可能性（频繁程度）"
        return WORDS[word] / N

    def known(words): 
        "返回words中在词汇表中的word列表"
        return set(w for w in words if w in WORDS)

    def edits1(word):
        "返回和单词 word 相差1个编辑距离的单词列表"
        letters    = 'abcdefghijklmnopqrstuvwxyz'
        splits     = [(word[:i], word[i:])    for i in range(len(word) + 1)]
        deletes    = [L + R[1:]               for L, R in splits if R]
        transposes = [L + R[1] + R[0] + R[2:] for L, R in splits if len(R)>1]
        replaces   = [L + c + R[1:]           for L, R in splits if R for c in letters]
        inserts    = [L + c + R               for L, R in splits for c in letters]
        return set(deletes + transposes + replaces + inserts)

    def edits2(word): 
        "返回和单词 word 相差2个编辑距离的单词列表"
        return (e2 for e1 in edits1(word) for e2 in edits1(e1))

参考文献：

- `数学之美番外篇：平凡而又神奇的贝叶斯方法 <http://mindhacks.cn/2008/09/21/the-magical-bayesian-method/>`_
- `朴素贝叶斯算法原理小结 <https://www.cnblogs.com/pinard/p/6069267.html>`_
- 《统计学习方法》/李航/第四章 朴素贝叶斯法
- https://scikit-learn.org/stable/modules/naive_bayes.html



