import puppeteer, { Browser, Page } from 'puppeteer';
import TurndownService from 'turndown';
// @ts-ignore
import { gfm } from 'turndown-plugin-gfm';
import crypto from 'crypto';

// Configure Turndown for better markdown output
const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
});
turndownService.use(gfm);
turndownService.addRule('codeBlocks', {
    filter: ['pre'],
    replacement: function (_content: string, node: Node) {
        const element = node as HTMLPreElement;
        const code = element.querySelector('code');
        const language = code?.className?.match(/language-(\w+)/)?.[1] || '';
        const codeContent = code?.textContent || element.textContent || '';
        return `\n\`\`\`${language}\n${codeContent}\n\`\`\`\n`;
    },
});

export interface ScrapedPage {
    url: string;
    title: string;
    markdown: string;
    hash: string;
    error?: string;
    childLinks: string[];
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
    }
    return browser;
}

/**
 * Attempt to extract article text directly from the undocumented Aura API to bypass Akamai bot detection.
 */
async function scrapeAuraArticle(urlStr: string, baseDomain?: string): Promise<ScrapedPage | null> {
    try {
        const url = new URL(urlStr);
        const articleId = url.searchParams.get('id');

        if (!articleId || !url.hostname.includes('help.salesforce.com') || !urlStr.includes('articleView')) {
            return null;
        }

        const payload = {
            "actions": [{
                "id": "1;a",
                "descriptor": "aura://ApexActionController/ACTION$execute",
                "callingDescriptor": "UNKNOWN",
                "params": {
                    "namespace": "",
                    "classname": "Help_ArticleDataController",
                    "method": "getData",
                    "params": {
                        "articleParameters": {
                            "urlName": articleId,
                            "language": "en_US",
                            "release": "260.0.0",
                            "requestedArticleType": "HelpDocs",
                            "requestedArticleTypeNumber": "5"
                        }
                    },
                    "cacheable": false,
                    "isContinuation": false
                }
            }]
        };

        const formData = new URLSearchParams();
        formData.append('message', JSON.stringify(payload));
        formData.append('aura.context', JSON.stringify({
            "mode": "PROD",
            "fwuid": "SHNaWGp5QlJqZFZLVGR5N0w0d0tYUTJEa1N5enhOU3R5QWl2VzNveFZTbGcxMy4tMjE0NzQ4MzY0OC45OTYxNDcy",
            "app": "siteforce:communityApp"
        }));
        formData.append('aura.pageURI', url.pathname + url.search);
        formData.append('aura.token', 'null');

        const response = await fetch('https://help.salesforce.com/s/sfsites/aura', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            },
            body: formData.toString()
        });

        if (!response.ok) return null;

        const jsonText = await response.text();
        const json = JSON.parse(jsonText);

        const actionResult = json.actions?.[0]?.returnValue;
        if (!actionResult || !actionResult.returnValue || !actionResult.returnValue.record) {
            return null;
        }

        const record = actionResult.returnValue.record;
        const htmlContent = record.Content__c || record.Summary;
        const title = record.Title || 'Salesforce Help Article';

        if (!htmlContent) return null;

        const markdown = turndownService.turndown(htmlContent);

        // Naive extraction of child links from HTML
        const childLinksMatch = [...htmlContent.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
        const cleanChildLinks = Array.from(new Set(
            childLinksMatch
                .filter(u => !u.startsWith('#') && !u.startsWith('java') && !u.startsWith('mailto'))
                .map(u => {
                    if (u.startsWith('http')) return u;
                    if (u.startsWith('/')) return `https://help.salesforce.com${u}`;
                    return `https://help.salesforce.com/s/${u}`;
                })
                .filter(u => !baseDomain || u.includes(baseDomain))
        ));

        const hash = crypto.createHash('md5').update(markdown).digest('hex');

        return {
            url: urlStr,
            title,
            markdown,
            hash,
            childLinks: cleanChildLinks
        };
    } catch (e) {
        return null;
    }
}

/**
 * Extracts content from a single URL, handling shadow DOMs, iframes, and various SFDC template structures.
 */
export async function scrapePage(url: string, baseDomain?: string): Promise<ScrapedPage> {
    // 1. Aura SPA Fast-Path directly hitting the backend Salesforce APIs
    const auraResult = await scrapeAuraArticle(url, baseDomain);
    if (auraResult) {
        return auraResult;
    }

    // 2. Headless Chrome Fallback for everything else (LWC, Standard Web, etc.)
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    try {
        await page.setViewport({ width: 1280, height: 800 });
        // User agent to look normal
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Wait until network is idle specifically to handle SPA renders and iframe loads
        const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

        // BUG-04 check: If the page returns an HTTP error code natively, fail fast.
        if (response && !response.ok()) {
            return {
                url,
                title: 'Error',
                markdown: '',
                hash: '',
                error: `HTTP Error ${response.status()}: ${response.statusText()}`,
                childLinks: []
            };
        }

        // Wait for specific Salesforce content locators to appear to avoid grabbing 'Loading...' pages
        try {
            if (url.includes('help.salesforce.com')) {
                await page.waitForSelector('.slds-text-longform', { timeout: 15000 });
            } else if (url.includes('developer.salesforce.com')) {
                await page.waitForFunction(() => {
                    return document.querySelector('doc-content-layout') ||
                        document.querySelector('doc-xml-content') ||
                        document.querySelector('iframe');
                }, { timeout: 10000 });
            }
        } catch (e) {
            console.warn(`Timeout waiting for specific content selectors on ${url}`);
        }

        // Additional wait just in case visual components are still sliding in
        await new Promise(r => setTimeout(r, 2000));

        // Take an opportunistic screenshot if development debugging layout issues
        if (url.includes('help.salesforce.com')) {
            await page.screenshot({ path: 'help_debug.png' }).catch(() => { });
        }

        // In-page extraction script
        const extraction = await page.evaluate(() => {
            let title = 'Untitled';
            let html = '';
            const childLinks = new Set<string>();

            // Collect all same-site hierarchical links (help to spider)
            document.querySelectorAll('a').forEach(a => {
                if (a.href && !a.href.startsWith('java') && !a.href.startsWith('mailto')) {
                    childLinks.add(a.href);
                }
            });

            // BUG-04: Catch soft 404s rendered by the SPA
            const pageTitle = document.querySelector('title')?.innerText || '';
            if (pageTitle.includes('404 Error')) {
                return { html: '', title: 'Error', error: 'HTTP 404 - Page Not Found', childLinks: Array.from(childLinks) };
            }

            // Catch SPA shells that failed to load content BEFORE generic tag fallbacks
            const bodyHtml = document.body.innerHTML;
            const isHelpSite = window.location.hostname.includes('help.salesforce.com');
            const hasHelpContent = !!document.querySelector('.slds-text-longform');

            // If it's a huge help site payload but the actual text container is missing, the SPA failed to hydrate
            if (bodyHtml.includes('Sorry to interrupt') || (isHelpSite && !hasHelpContent && bodyHtml.length > 100000)) {
                return {
                    html: '',
                    title: 'Error',
                    error: 'Found no accessible documentation content on this page. It may require authentication, be a soft 404, rendering timed out, or JavaScript rendering is required.',
                    childLinks: []
                };
            }


            // Helper function to extract readable HTML piercing shadow DOMs (legacy sf-doc-scraper behavior)
            function extractReadableHTML(element: Element): string {
                if (!element) return '';
                const tagName = element.tagName?.toLowerCase();

                if (tagName === 'doc-heading') {
                    const headingEl = element.shadowRoot?.querySelector('h2, h3, h4');
                    const headingContent = element.shadowRoot?.querySelector('doc-heading-content');
                    const titleSpan = (headingContent as Element | null)?.shadowRoot?.querySelector('.title');
                    const headingText = titleSpan?.textContent?.trim() || element.getAttribute('header') || '';
                    const level = headingEl?.tagName?.toLowerCase() || 'h2';
                    return `<${level}>${headingText}</${level}>`;
                }

                if (tagName === 'doc-content-callout') {
                    const shadowDiv = element.shadowRoot?.querySelector('.dx-callout');
                    const isTip = shadowDiv?.classList?.contains('dx-callout-tip');
                    const isWarning = shadowDiv?.classList?.contains('dx-callout-warning');
                    let calloutType = 'Note';
                    if (isTip) calloutType = 'Tip';
                    if (isWarning) calloutType = 'Warning';
                    const slottedContent = element.innerHTML;
                    return `<blockquote><strong>${calloutType}:</strong> ${slottedContent}</blockquote>`;
                }

                if (tagName === 'dx-code-block') {
                    const language = element.getAttribute('language') || '';
                    const code = element.getAttribute('code-block') || element.textContent || '';
                    const decodedCode = code
                        .replace(/&quot;/g, '"')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&');
                    return `<pre><code class="language-${language}">${decodedCode}</code></pre>`;
                }

                if (tagName === 'div' && element.classList?.contains('custom-code-block')) {
                    const codeBlock = element.querySelector('dx-code-block');
                    if (codeBlock) return extractReadableHTML(codeBlock);
                }
                return element.outerHTML;
            }

            // Helper function to find element deep in shadow DOMs
            function deepQuerySelector(root: Document | Element | ShadowRoot, selector: string): Element | null {
                const found = root.querySelector(selector);
                if (found) return found;

                const allElements = root.querySelectorAll('*');
                for (const el of Array.from(allElements)) {
                    if (el.shadowRoot) {
                        const deepFound = deepQuerySelector(el.shadowRoot, selector);
                        if (deepFound) return deepFound;
                    }
                }
                return null;
            }

            // 1. Try to extract from an iframe (Older Developer Guides like life_sciences_dev_guide)
            const iframe = document.querySelector('iframe');
            if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                // Find main content inside iframe
                const docHtml = iframe.contentDocument.querySelector('#doc')?.innerHTML ||
                    iframe.contentDocument.querySelector('body')?.innerHTML || '';
                const docTitle = iframe.contentDocument.querySelector('title')?.innerText ||
                    iframe.contentDocument.querySelector('h1')?.innerText || 'Untitled';

                // Get links inside iframe
                iframe.contentDocument.querySelectorAll('a').forEach(a => {
                    if (a.href && !a.href.startsWith('java') && !a.href.startsWith('mailto')) {
                        childLinks.add(a.href);
                    }
                });

                if (docHtml.length > 500) {
                    return { html: docHtml, title: docTitle, childLinks: Array.from(childLinks) };
                }
            }

            // 2. Try help.salesforce.com specific structure (often inside shadow DOMs)
            const sldsText = deepQuerySelector(document, '.slds-text-longform');
            if (sldsText) {
                const rawTitle = document.querySelector('title')?.innerText || 'Untitled';
                const cleanTitle = rawTitle.replace(' | Salesforce', '').trim();
                return { html: sldsText.innerHTML, title: cleanTitle, childLinks: Array.from(childLinks) };
            }

            // 2.5 Try doc-xml-content (Legacy Developer Guides, like Health Cloud / Life Sciences)
            const docXmlContent = document.querySelector('doc-xml-content');
            if (docXmlContent?.shadowRoot) {
                const docContent = docXmlContent.shadowRoot.querySelector('doc-content');
                if (docContent?.shadowRoot) {
                    const innerHtml = docContent.shadowRoot.innerHTML;
                    // Extract title from h1
                    const h1Match = innerHtml.match(/<h1[^>]*>(.*?)<\/h1>/);
                    if (h1Match) title = h1Match[1].replace(/<[^>]*>?/gm, '');

                    // Find child links within the shadow DOM
                    const shadowLinks = docContent.shadowRoot.querySelectorAll('a');
                    shadowLinks.forEach(a => {
                        if (a.href && !a.href.startsWith('java') && !a.href.startsWith('mailto')) {
                            childLinks.add(a.href);
                        }
                    });

                    return { html: innerHtml, title, childLinks: Array.from(childLinks) };
                }
            }

            // 3. Try doc-content-layout / doc-amf-reference (New Developer Guides)
            const docRef = document.querySelector('doc-amf-reference');
            if (docRef) {
                const markdownContent = docRef.querySelector('.markdown-content');
                if (markdownContent) {
                    let refHtml = '';
                    for (const el of Array.from(markdownContent.children)) {
                        if (el.tagName?.toLowerCase() === 'h1') title = el.textContent?.trim() || title;
                        refHtml += extractReadableHTML(el);
                    }
                    if (!title || title === 'Untitled') title = document.querySelector('title')?.innerText || 'Untitled';
                    return { html: refHtml, title, childLinks: Array.from(childLinks) };
                }
            }

            const docLayout = document.querySelector('doc-content-layout');
            if (docLayout?.shadowRoot) {
                const slot = docLayout.shadowRoot.querySelector('.content-body slot') as HTMLSlotElement | null;
                if (slot) {
                    const assignedElements = slot.assignedElements();
                    if (assignedElements.length > 0) {
                        let guideHtml = '';
                        for (const el of assignedElements) {
                            if (el.tagName?.toLowerCase() === 'h1') title = el.textContent?.trim() || title;
                            guideHtml += extractReadableHTML(el);
                        }
                        if (!title || title === 'Untitled') title = document.querySelector('title')?.innerText || 'Untitled';
                        return { html: guideHtml, title, childLinks: Array.from(childLinks) };
                    }
                }
            }

            // 4. Fallback: <article> or <main>
            const container = document.querySelector('article') || document.querySelector('main');
            if (container) {
                title = document.querySelector('h1')?.innerText || document.querySelector('title')?.innerText || 'Untitled';
                return { html: container.innerHTML, title, childLinks: Array.from(childLinks) };
            }

            // Complete fallback - BUG-01 & BUG-02
            // If we fall all the way down here, it means no documentation tags were found. 
            // If the body is massive, it is almost certainly a JS application shell (like help.salesforce)
            // or a 404 rendered in SPA mode. Do not dump 250kb of useless code to the AI.

            if (isHelpSite || bodyHtml.length > 100000) {
                return {
                    html: '',
                    title: 'Error. Found no accessible documentation content on this page. It may require authentication, be a soft 404, rendering timed out, or JavaScript rendering is required.',
                    childLinks: []
                };
            }

            return {
                html: bodyHtml,
                title: document.querySelector('title')?.innerText || 'Untitled',
                childLinks: Array.from(childLinks)
            };
        });

        if (!extraction.html || extraction.html.trim() === '') {
            return {
                url,
                title: extraction.title || 'Untitled',
                markdown: '',
                hash: '',
                error: (extraction as any).error || 'No content found on page',
                childLinks: extraction.childLinks || []
            };
        }

        // Convert to markdown
        let markdown = turndownService.turndown(extraction.html);

        // Filter child links to stay within the domain/base if provided, to avoid massive spidering
        let validLinks = extraction.childLinks;
        if (baseDomain) {
            validLinks = validLinks.filter(l => l.startsWith(baseDomain));
        }

        const hash = crypto.createHash('sha256').update(markdown).digest('hex');

        return {
            url,
            title: extraction.title,
            markdown,
            hash,
            childLinks: validLinks,
        };
    } catch (error: any) {
        return {
            url,
            title: 'Error',
            markdown: '',
            hash: '',
            error: error.message,
            childLinks: [],
        };
    } finally {
        await page.close();
    }
}

/**
 * Ensures the browser is closed when application shuts down
 */
export async function closeBrowser() {
    if (browser) {
        await browser.close();
        browser = null;
    }
}
