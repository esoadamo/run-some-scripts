# run-a-script

## Changes against original repo

- multi-rule support: define multiple scripts, each scoped to a URL glob pattern
- per-rule optional injection of jQuery and GRenderer
- import/export rules as JSON
- fixed manifest to work with newest addon submission policies
- added easy makefile for extension compilation

## Links

[![SemVer](https://img.shields.io/badge/version-1.1.0-brightgreen.svg)](http://semver.org)
[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](http://www.gnu.org/licenses/gpl-3.0)

A Firefox extension that lets you define **multiple JS scripts** and inject them into web pages matching **URL glob patterns**. It uses Firefox' [userScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts) API which sandboxes JS code before execution. For each rule you can optionally inject [jQuery](https://jquery.com/) and/or [GRenderer](https://github.com/QRGameStudio/web-libs) as dependencies. The code of the extension is deliberately minimal — you are encouraged to review it for security before running it. Please report all problems you find in the [issues](https://github.com/esoadamo/run-a-script/issues).

run-a-script is meant for people with trust issues. There are plenty of extensions out there that you could easily re-implement with a small JS snippet instead of installing. Also useful with [uBlock Origin](https://github.com/gorhill/uBlock) for defeating aggressive sites.

The plugin supports:
* multiple rules, each with its own script and URL pattern
* URL glob matching (`*` = all pages, `*example.com*` = specific domain, `*://example.com/path/*` = specific path)
* optional jQuery injection per rule
* optional GRenderer injection per rule
* enabling / disabling individual rules
* import and export of rules as JSON
* automatic migration of settings from v1.0.x (single-script format)

The plugin does NOT support:
* Android – but working on it
* Chrome – the whole idea of this extension is to be secure but that's irrelevant if your browser is a black box
* saving to and loading from a file – saving would be useful but currently not possible due to a [Firefox bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1292701)

## URL Glob Syntax

Each rule has a URL pattern field that uses Firefox's glob syntax:

| Pattern | Matches |
|---------|---------|
| `*` | All HTTP/HTTPS pages (default) |
| `*example.com*` | Any URL containing `example.com` |
| `*://example.com/*` | All pages on `example.com` |
| `*://example.com/path/*` | Pages under a specific path |
| `*://example.com/*.html` | Only `.html` pages on `example.com` |

Wildcards: `*` matches zero or more characters, `?` matches exactly one character.

## Example

Here's a sample rule setup:

**Rule 1** – Redirect helpers (URL pattern: `*`, Inject jQuery: ✓)

```
console.log("The execution of the custom code is beginning.");

const GIPHY_REDIRECT_ONLY_GIFS = true;
const GFYCAT_PREFER_GIFS = false;

var redirects = {
    "www.google.com": ["www.startpage.com", (url) => !url.pathname.startsWith("/maps")],
    "www.youtube.com": "yewtu.be",
    "www.reddit.com": ["old.reddit.com", (url) => !url.pathname.startsWith("/gallery/")],
    "twitter.com": "nitter.net",
};

var url = document.URL;
var { host, protocol, pathname, search } = new URL(url);

function goToUrl(url) {
    window.stop();
    window.location.replace(url);
}

var redirect = redirects[host];

if (redirect) {
    if (typeof redirect === "object") {
        if (redirect[1](new URL(document.URL))) {
            goToUrl(url.replace(`${protocol}//${host}`, `${protocol}//${redirect[0]}`));
        }
    } else if (typeof redirect === "string") {
        goToUrl(url.replace(`${protocol}//${host}`, `${protocol}//${redirect}`));
    } else {
        redirect();
    }
}

console.log("The execution of the custom code is finishing.");
```

**Rule 2** – Hide cookie banners (URL pattern: `*`, Inject jQuery: ✓)

```
$(document).ready(function() {
    $('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"]').remove();
});
```

## License

Copyright © 2022-present Mihail Ivanchev.

Distributed under the GNU General Public License, Version 3 (GNU GPLv3).

The doge icon was sourced from https://icon-library.com/icon/doge-icon-21.html and subsequently modified.

jQuery is distributed under [its respective license](https://jquery.org/license/).

GRenderer is from [QRGameStudio/web-libs](https://github.com/QRGameStudio/web-libs).

