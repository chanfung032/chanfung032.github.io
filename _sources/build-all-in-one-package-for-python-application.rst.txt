如何构建一个All In One的Python Package
##########################################

以 rpm 包为例：

.. code-block:: spec

   # python-xxx.spec

   %build
   virtualenv xxx
   . xxx/bin/activate

   # 安装python应用程序
   # pip install blah blah
   # python setup.py install
   # ...

   virtualenv --relocatable xxx

   %install
   cp -rf xxx %{buildroot}/usr/local/xxx
