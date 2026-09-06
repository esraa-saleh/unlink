const trace={
 gmail:{url:"https://mail.google.com/",domain:"gmail.com"},
 drive:{url:"https://drive.google.com/",domain:"drive.google.com"},
 search:{url:"https://www.google.com/search?q=unlink+privacy+demo",domain:"google.com"},
 wiki:{url:"https://www.wikipedia.org/",domain:"wikipedia.org"},
 reddit:{url:"https://www.reddit.com/",domain:"reddit.com"},
 bbc:{url:"https://www.bbc.com/",domain:"bbc.com"}
};

document.querySelectorAll("[data-key]").forEach(button => {
  button.addEventListener("click", async () => {
    const item = trace[button.dataset.key];
    if (!item?.url) return;
    await browser.tabs.create({url:item.url, active:true});
  });
});


