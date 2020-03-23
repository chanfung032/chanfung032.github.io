Nginx Lua 剖析
==================

以下面的 nginx.conf 为例，我们来看下 nginx lua 的执行过程。

.. code-block:: nginx

    http {
        server {
            listen 80;
            location / {
                default_type text/html;
                content_by_lua 'ngx.say("<p>hello, world</p>")';
            }
        }
    }

配置加载和初始化
-------------------

.. code-block:: c

    ngx_module_t ngx_http_lua_module = {
        NGX_MODULE_V1,
        &ngx_http_lua_module_ctx,   /*  module context */
        ngx_http_lua_cmds,          /*  module directives */
        NGX_HTTP_MODULE,            /*  module type */
        NULL,                       /*  init master */
        NULL,                       /*  init module */
        ngx_http_lua_init_worker,   /*  init process */
        NULL,                       /*  init thread */
        NULL,                       /*  exit thread */
        NULL,                       /*  exit process */
        NULL,                       /*  exit master */
        NGX_MODULE_V1_PADDING
    };

    ngx_http_module_t ngx_http_lua_module_ctx = {
        NULL,                             /*  preconfiguration */
        ngx_http_lua_init,                /*  postconfiguration */

        ngx_http_lua_create_main_conf,    /*  create main configuration */
        ngx_http_lua_init_main_conf,      /*  init main configuration */

        NULL,                             /*  create server configuration */
        NULL,                             /*  merge server configuration */

        ngx_http_lua_create_loc_conf,     /*  create location configuration */
        ngx_http_lua_merge_loc_conf       /*  merge location configuration */
    };

    static ngx_command_t ngx_http_lua_cmds[] = {
        // ...

        { ngx_string("content_by_lua"),
          NGX_HTTP_LOC_CONF|NGX_HTTP_LIF_CONF|NGX_CONF_TAKE1,
          ngx_http_lua_content_by_lua,
          NGX_HTTP_LOC_CONF_OFFSET,
          0,
          (void *) ngx_http_lua_content_handler_inline },

        // ...
        ngx_null_command
    };

首先，在配置加载阶段，比较重要的是以下两个函数：

1. 在 nginx.conf 中读到 content_by_lua 指令时的回调函数 *ngx_http_lua_content_by_lua*。
2. nginx.conf 加载完成后阶段（postconfiguration）初始化 lua vm 的函数 *ngx_http_lua_init*。

content_by_lua 指令的回调函数做的事情很简单，就是保存代码到该 location 对应的 lua module location configuration 中，然后配置 nginx 让在其在 content phase 调用 lua module 的 handler 来生成 http 响应。

.. code-block:: c

    char *
    ngx_http_lua_content_by_lua(ngx_conf_t *cf, ngx_command_t *cmd, void *conf)
    {
        u_char                      *p;
        u_char                      *chunkname;
        ngx_str_t                   *value;
        ngx_http_core_loc_conf_t    *clcf;
        ngx_http_lua_main_conf_t    *lmcf;
        ngx_http_lua_loc_conf_t     *llcf = conf;

        value = cf->args->elts;

        // 保存 lua 代码到当前 location 的 lua module 配置中。
        if (cmd->post == ngx_http_lua_content_handler_inline) {
            chunkname = ngx_http_lua_gen_chunk_name(cf, "content_by_lua",
                                                    sizeof("content_by_lua") - 1);
            llcf->content_chunkname = chunkname;
            llcf->content_src.value = value[1];
            p = ngx_palloc(cf->pool, NGX_HTTP_LUA_INLINE_KEY_LEN + 1);
            llcf->content_src_key = p;
            p = ngx_copy(p, NGX_HTTP_LUA_INLINE_TAG, NGX_HTTP_LUA_INLINE_TAG_LEN);
            p = ngx_http_lua_digest_hex(p, value[1].data, value[1].len);
            *p = '\0';
        }

        llcf->content_handler = (ngx_http_handler_pt) cmd->post;

        // 将 ngx_http_lua_capture_header_filter 和
        // ngx_http_lua_capture_body_filter 插入到 header 和 body filter 链中
        // lmcf = ngx_http_conf_get_module_main_conf(cf, ngx_http_lua_module);
        // lmcf->requires_capture_filter = 1;

        // 设置 nginx 在 content phase 调用 ngx_http_lua_content_handler
        // 来生成响应。
        clcf = ngx_http_conf_get_module_loc_conf(cf, ngx_http_core_module);
        clcf->handler = ngx_http_lua_content_handler;

        return NGX_CONF_OK;
    }

所有的配置解析处理完毕后，nginx 会回调 ngx_http_lua_init 函数初始化 lua vm。

.. code-block:: c

    static ngx_int_t
    ngx_http_lua_init(ngx_conf_t *cf)
    {
        ngx_http_lua_main_conf_t   *lmcf;

        lmcf = ngx_http_conf_get_module_main_conf(cf, ngx_http_lua_module);

        if (lmcf->lua == NULL) {
            // 初始化 lua 虚拟机
            lmcf->lua = ngx_http_lua_init_vm(NULL, cf->cycle, cf->pool, lmcf,
                                             cf->log, NULL);
        }

        return NGX_OK;
    }

    lua_State *
    ngx_http_lua_init_vm(lua_State *parent_vm, ngx_cycle_t *cycle,
        ngx_pool_t *pool, ngx_http_lua_main_conf_t *lmcf, ngx_log_t *log,
        ngx_pool_cleanup_t **pcln)
    {
        lua_State  *L;
        L = ngx_http_lua_new_state(parent_vm, cycle, lmcf, log);
        return L;
    }

    static lua_State *
    ngx_http_lua_new_state(lua_State *parent_vm, ngx_cycle_t *cycle,
        ngx_http_lua_main_conf_t *lmcf, ngx_log_t *log)
    {
        L = luaL_newstate();
        luaL_openlibs(L);

        lua_getglobal(L, "package");
        // ... 设置 package.path 和 package.cpath 等
        lua_pop(L, 1); /* remove the "package" table */

        // 创建用来保存 coroutine 和 code cache 等的全局 table
        // LUA_REGISTRYINDEX[&ngx_http_lua_coroutines_key] = {}
        // LUA_REGISTRYINDEX[&ngx_http_lua_code_cache_key] = {}
        // ...
        ngx_http_lua_init_registry(L, log);

        // 调用 ngx_http_lua_inject_* 函数注入 ngx.* 常量和 api。
        ngx_http_lua_init_globals(L, cycle, lmcf, log);

        return L;
    }

代码运行
----------------

在 nginx 请求处理的 content 阶段，nginx 会回调之前配置阶段设置的 *ngx_http_lua_content_handler* 来处理请求生成响应。（关于 nginx 多阶段处理请求可以参考：http://tengine.taobao.org/book/chapter_12.html#id8）

*ngx_http_lua_content_handler* 会创建将 content_by_lua 的 lua 代码放在下面的 ... 处，编译，缓存。

    | return function()
    | ...
    | end

然后，创建一个新的 coroutine，在这个 coroutine 中运行编译好的 lua 代码。

如果 lua 代码没有执行完毕，比如调用 *ngx.sleep(1)* 接口，该函数会调用 nginx 的接口添加一个 timer，然后 yield 返回。最终从 *ngx_http_lua_content_handler* 中返回。当 timer 事件触发后，nginx 会继续 run phase，这个时候会再次回调 *ngx_http_lua_content_handler* ，该 hanndler 会调用 lua_resume 继续从上次 yield 的地方继续向下执行。

.. code-block:: c

    ngx_int_t
    ngx_http_lua_content_handler(ngx_http_request_t *r)
    {
        ngx_http_lua_loc_conf_t     *llcf;
        ngx_http_lua_ctx_t          *ctx;
        ngx_int_t                    rc;

        llcf = ngx_http_get_module_loc_conf(r, ngx_http_lua_module);

        ctx = ngx_http_get_module_ctx(r, ngx_http_lua_module);
        if (ctx == NULL) {
            ctx = ngx_http_lua_create_ctx(r);
        }

        if (ctx->entered_content_phase) {
            // 重入 content handler ，调用 resume_handler 恢复 lua 从 yield 地方继续执行
            rc = ctx->resume_handler(r);
            return rc;
        }

        // 第一次调用 content handler，调用 content_by_lua cmd.post 执行 lua 代码
        // 也就是 ngx_http_lua_content_handler_inline。
        ctx->entered_content_phase = 1;
        return llcf->content_handler(r);
    }

    ngx_int_t
    ngx_http_lua_content_handler_inline(ngx_http_request_t *r)
    {
        lua_State                   *L;
        ngx_int_t                    rc;
        ngx_http_lua_loc_conf_t     *llcf;

        llcf = ngx_http_get_module_loc_conf(r, ngx_http_lua_module);

        L = ngx_http_lua_get_lua_vm(r, NULL);

        // lua code 会被插入到下面 ... 处
        //    return function()
        //        ...
        //    end
        // 编译并缓存到 LUA_REGISTRYINDEX[&ngx_http_lua_code_cache_key] 这个 table 中
        rc = ngx_http_lua_cache_loadbuffer(r, L, llcf->content_src.value.data,
                                           llcf->content_src.value.len,
                                           llcf->content_src_key,
                                           (const char *)
                                           llcf->content_chunkname);

        return ngx_http_lua_content_by_chunk(L, r);
    }

    ngx_int_t
    ngx_http_lua_content_by_chunk(lua_State *L, ngx_http_request_t *r)
    {
        int                      co_ref;
        ngx_int_t                rc;
        lua_State               *co;
        ngx_http_lua_ctx_t      *ctx;
        ngx_http_cleanup_t      *cln;
        ngx_http_lua_loc_conf_t      *llcf;

        ctx = ngx_http_get_module_ctx(r, ngx_http_lua_module);

        if (ctx == NULL) {
            ctx = ngx_http_lua_create_ctx(r);
        } else {
            ngx_http_lua_reset_ctx(r, L, ctx);
        }

        ctx->entered_content_phase = 1;

        // 创建一个新的 coroutine 用来执行 lua 代码
        co = ngx_http_lua_new_thread(r, L, &co_ref);

        // 将 lua 代码从 vm 的 L 中移到新建的 co 中
        lua_xmove(L, co, 1);

        /*  set closure's env table to new coroutine's globals table */
        ngx_http_lua_get_globals_table(co);
        lua_setfenv(co, -2);

        // 将 r 指针放入 coroutine 的 globals table 中，name 为 __ngx_req
        // ngx.req.* 相关的函数会通过 __ngx_req 取到 r 指针，然后获取函数需要的数据。
        ngx_http_lua_set_req(co, r);

        // 保存当前运行的 coroutine 的上下文信息
        ctx->cur_co_ctx = &ctx->entry_co_ctx;
        ctx->cur_co_ctx->co = co;
        ctx->cur_co_ctx->co_ref = co_ref;

        if (ctx->cleanup == NULL) {
            cln = ngx_http_cleanup_add(r, 0);
            cln->handler = ngx_http_lua_request_cleanup_handler;
            cln->data = ctx;
            ctx->cleanup = &cln->handler;
        }

        ctx->context = NGX_HTTP_LUA_CONTEXT_CONTENT;

        llcf = ngx_http_get_module_loc_conf(r, ngx_http_lua_module);
        if (llcf->check_client_abort) {
            r->read_event_handler = ngx_http_lua_rd_check_broken_connection;
        } else {
            r->read_event_handler = ngx_http_block_reading;
        }

        // 执行 lua 代码，如果代码 yield 了，那么 yield 的地方会注册对应的事件，
        // 并设置 ctx->resume_handler，事件触发后 nginx 会再次调用当前 content
        // handler 继续 run phase，此时 content handler 会直接调用 ctx->resume_handler
        // 继续执行 coroutine。
        rc = ngx_http_lua_run_thread(L, r, ctx, 0);

        if (rc == NGX_ERROR || rc >= NGX_OK) {
            return rc;
        }

        // 如果前面的 lua 代码中有创建新的 coroutine，执行这些 coroutine。
        if (rc == NGX_AGAIN) {
            return ngx_http_lua_content_run_posted_threads(L, r, ctx, 0);
        }
        if (rc == NGX_DONE) {
            return ngx_http_lua_content_run_posted_threads(L, r, ctx, 1);
        }

        return NGX_OK;
    }

lua 代码调用了 *ngx.say()* （也就是在 *ngx_http_lua_init* 中 inject 进去的 API）来输出 http response body。这个函数是封装了 ngx_http_output_filter ，用来向客户端发送 http 响应。

.. code-block:: c

    static int
    ngx_http_lua_ngx_say(lua_State *L)
    {
        return ngx_http_lua_ngx_echo(L, 1);
    }

    static int
    ngx_http_lua_ngx_echo(lua_State *L, unsigned newline)
    {
        r = ngx_http_lua_get_req(L);

        ctx = ngx_http_get_module_ctx(r, ngx_http_lua_module);

        // 计算所有参数转化成 string 后加起来的大小
        nargs = lua_gettop(L);
        size = 0;
        for (i = 1; i <= nargs; i++) {
            type = lua_type(L, i);
            switch (type) {
                case LUA_TNUMBER:
                case LUA_TSTRING:
                    lua_tolstring(L, i, &len);
                    size += len;
                    break;
                // ...
                default:
            }
        }
        if (newline) {
            size += sizeof("\n") - 1;
        }

        // 创建一个新的 buf 用来发送响应内容
        cl = ngx_http_lua_chain_get_free_buf(r->connection->log, r->pool,
                                             &ctx->free_bufs, size);
        b = cl->buf;

        // 将 ngx.say 的内容 copy 到 buf 中准备发送。
        for (i = 1; i <= nargs; i++) {
            type = lua_type(L, i);
            switch (type) {
                case LUA_TNUMBER:
                case LUA_TSTRING:
                    p = lua_tolstring(L, i, &len);
                    b->last = ngx_copy(b->last, (u_char *) p, len);
                    break;
               // ...
            }
        }
        if (newline) {
            *b->last++ = '\n';
        }

        // 这个函数最终会调用 ngx_http_output_filter 来向客户端发送 http 响应。
        rc = ngx_http_lua_send_chain_link(r, ctx, cl);

        lua_pushinteger(L, 1);
        return 1;
    }

cosocket
-----------

cosocket 通过 lua 的 coroutine 将 nginx 的异步 socket 封装成了同步的 socket 接口。类似与 Go 的 net 库，这里 nginx 等价于 Go 里的 netpoller，cosocket 就是 net 库.

参考：

- openresty 源码剖析——lua 代码的加载 http://www.cnblogs.com/magicsoar/p/6774872.html
- openresty 源码剖析——lua 代码的执行 http://www.cnblogs.com/magicsoar/p/6832204.html
- Lua Application Program Interface: https://www.lua.org/manual/5.1/manual.html#3
