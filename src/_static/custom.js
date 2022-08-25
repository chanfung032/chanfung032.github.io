var runWhenDOMLoaded = cb => {
    if (document.readyState != 'loading') {
        cb()
    } else if (document.addEventListener) {
        document.addEventListener('DOMContentLoaded', cb)
    } else {
        document.attachEvent('onreadystatechange', function() {
            if (document.readyState == 'complete') cb()
        })
    }
}

var customize = () => {
    if (document.querySelector(".toctree-wrapper") != null) {
        document.querySelectorAll('li.toctree-l1').forEach((x) => {
            if (x.firstChild.href.endsWith('/index.html')) 
                x.appendChild(document.createTextNode(" 🌟"))
        });
        return
    }

    // addUtterances 
    var script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://utteranc.es/client.js";
    script.async = "async";
    script.setAttribute("repo", "chanfung032/chanfung032.github.io");
    script.setAttribute("issue-term", "pathname");
    script.setAttribute("theme", "github-light");
    script.setAttribute("label", "");
    script.setAttribute("crossorigin", "anonymous");
    var body = document.querySelector("div.body");
    if (body !== null) {
        body.appendChild(script);
    }
}

runWhenDOMLoaded(customize);
