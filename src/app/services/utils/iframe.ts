// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';
import { WKUserScriptWindow, WKUserScriptInjectionTime } from 'cordova-plugin-wkuserscript';

import { CoreApp, CoreAppProvider } from '@services/app';
import { CoreFile } from '@services/file';
import { CoreFileHelper } from '@services/file-helper';
import { CoreSites } from '@services/sites';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreTextUtils } from '@services/utils/text';
import { CoreUrlUtils } from '@services/utils/url';
import { CoreUtils } from '@services/utils/utils';

import { makeSingleton, Translate, Network, Platform, NgZone } from '@singletons/core.singletons';
import { CoreLogger } from '@singletons/logger';
import { CoreUrl } from '@singletons/url';
import { CoreWindow } from '@singletons/window';

/*
 * "Utils" service with helper functions for iframes, embed and similar.
 */
@Injectable()
export class CoreIframeUtilsProvider {
    static FRAME_TAGS = ['iframe', 'frame', 'object', 'embed'];

    protected logger: CoreLogger;

    constructor() {
        this.logger = CoreLogger.getInstance('CoreUtilsProvider');

        const win = <WKUserScriptWindow> window;

        if (CoreApp.instance.isIOS() && win.WKUserScript) {
            Platform.instance.ready().then(() => {
                // Inject code to the iframes because we cannot access the online ones.
                const wwwPath = CoreFile.instance.getWWWAbsolutePath();
                const linksPath = CoreTextUtils.instance.concatenatePaths(wwwPath, 'assets/js/iframe-treat-links.js');
                const recaptchaPath = CoreTextUtils.instance.concatenatePaths(wwwPath, 'assets/js/iframe-recaptcha.js');

                win.WKUserScript.addScript({id: 'CoreIframeUtilsLinksScript', file: linksPath});
                win.WKUserScript.addScript({
                    id: 'CoreIframeUtilsRecaptchaScript',
                    file: recaptchaPath,
                    injectionTime: WKUserScriptInjectionTime.END,
                });

                // Handle post messages received by iframes.
                window.addEventListener('message', this.handleIframeMessage.bind(this));
            });
        }
    }

    /**
     * Check if a frame uses an online URL but the app is offline. If it does, the iframe is hidden and a warning is shown.
     *
     * @param element The frame to check (iframe, embed, ...).
     * @param isSubframe Whether it's a frame inside another frame.
     * @return True if frame is online and the app is offline, false otherwise.
     */
    checkOnlineFrameInOffline(element: any, isSubframe?: boolean): boolean {
        const src = element.src || element.data;

        if (src && src != 'about:blank' && !CoreUrlUtils.instance.isLocalFileUrl(src) && !CoreApp.instance.isOnline()) {
            if (element.classList.contains('core-iframe-offline-disabled')) {
                // Iframe already hidden, stop.
                return true;
            }

            // The frame has an online URL but the app is offline. Show a warning, or a link if the URL can be opened in the app.
            const div = document.createElement('div');

            div.setAttribute('text-center', '');
            div.setAttribute('padding', '');
            div.classList.add('core-iframe-offline-warning');

            const site = CoreSites.instance.getCurrentSite();
            const username = site ? site.getInfo().username : undefined;
            // @todo Handle link

            // Add a class to specify that the iframe is hidden.
            element.classList.add('core-iframe-offline-disabled');

            if (isSubframe) {
                // We cannot apply CSS styles in subframes, just hide the iframe.
                element.style.display = 'none';
            }

            // If the network changes, check it again.
            const subscription = Network.instance.onConnect().subscribe(() => {
                // Execute the callback in the Angular zone, so change detection doesn't stop working.
                NgZone.instance.run(() => {
                    if (!this.checkOnlineFrameInOffline(element, isSubframe)) {
                        // Now the app is online, no need to check connection again.
                        subscription.unsubscribe();
                    }
                });
            });

            return true;
        } else if (element.classList.contains('core-iframe-offline-disabled')) {
            // Reload the frame.
            element.src = element.src;
            element.data = element.data;

            // Remove the warning and show the iframe
            CoreDomUtils.instance.removeElement(element.parentElement, 'div.core-iframe-offline-warning');
            element.classList.remove('core-iframe-offline-disabled');

            if (isSubframe) {
                element.style.display = '';
            }
        }

        return false;
    }

    /**
     * Given an element, return the content window and document.
     * Please notice that the element should be an iframe, embed or similar.
     *
     * @param element Element to treat (iframe, embed, ...).
     * @return Window and Document.
     */
    getContentWindowAndDocument(element: any): { window: Window, document: Document } {
        let contentWindow: Window = element.contentWindow;
        let contentDocument: Document;

        try {
            contentDocument = element.contentDocument || (contentWindow && contentWindow.document);
        } catch (ex) {
            // Ignore errors.
        }

        if (!contentWindow && contentDocument) {
            // It's probably an <object>. Try to get the window.
            contentWindow = contentDocument.defaultView;
        }

        if (!contentWindow && element.getSVGDocument) {
            // It's probably an <embed>. Try to get the window and the document.
            try {
                contentDocument = element.getSVGDocument();
            } catch (ex) {
                // Ignore errors.
            }

            if (contentDocument && contentDocument.defaultView) {
                contentWindow = contentDocument.defaultView;
            } else if (element.window) {
                contentWindow = element.window;
            } else if (element.getWindow) {
                contentWindow = element.getWindow();
            }
        }

        return { window: contentWindow, document: contentDocument };
    }

    /**
     * Handle some iframe messages.
     *
     * @param event Message event.
     */
    handleIframeMessage(event: MessageEvent): void {
        if (!event.data || event.data.environment != 'moodleapp' || event.data.context != 'iframe') {
            return;
        }

        switch (event.data.action) {
            case 'window_open':
                this.windowOpen(event.data.url, event.data.name);
                break;

            case 'link_clicked':
                this.linkClicked(event.data.link);
                break;

            default:
                break;
        }
    }

    /**
     * Redefine the open method in the contentWindow of an element and the sub frames.
     * Please notice that the element should be an iframe, embed or similar.
     *
     * @param element Element to treat (iframe, embed, ...).
     * @param contentWindow The window of the element contents.
     * @param contentDocument The document of the element contents.
     * @param navCtrl NavController to use if a link can be opened in the app.
     */
    redefineWindowOpen(element: any, contentWindow: Window, contentDocument: Document, navCtrl?: any): void {
        if (contentWindow) {
            // Intercept window.open.
            (<any> contentWindow).open = (url: string, name: string): Window => {
                this.windowOpen(url, name, element, navCtrl);

                return null;
            };
        }

        if (contentDocument) {
            // Search sub frames.
            CoreIframeUtilsProvider.FRAME_TAGS.forEach((tag) => {
                const elements = Array.from(contentDocument.querySelectorAll(tag));
                elements.forEach((subElement) => {
                    this.treatFrame(subElement, true, navCtrl);
                });
            });
        }
    }

    /**
     * Intercept window.open in a frame and its subframes, shows an error modal instead.
     * Search links (<a>) and open them in browser or InAppBrowser if needed.
     *
     * @param element Element to treat (iframe, embed, ...).
     * @param isSubframe Whether it's a frame inside another frame.
     * @param navCtrl NavController to use if a link can be opened in the app.
     */
    treatFrame(element: any, isSubframe?: boolean, navCtrl?: any): void {
        if (element) {
            this.checkOnlineFrameInOffline(element, isSubframe);

            let winAndDoc = this.getContentWindowAndDocument(element);
            // Redefine window.open in this element and sub frames, it might have been loaded already.
            this.redefineWindowOpen(element, winAndDoc.window, winAndDoc.document, navCtrl);
            // Treat links.
            this.treatFrameLinks(element, winAndDoc.document);

            element.addEventListener('load', () => {
                this.checkOnlineFrameInOffline(element, isSubframe);

                // Element loaded, redefine window.open and treat links again.
                winAndDoc = this.getContentWindowAndDocument(element);
                this.redefineWindowOpen(element, winAndDoc.window, winAndDoc.document, navCtrl);
                this.treatFrameLinks(element, winAndDoc.document);

                if (winAndDoc.window) {
                    // Send a resize events to the iframe so it calculates the right size if needed.
                    setTimeout(() => {
                        winAndDoc.window.dispatchEvent(new Event('resize'));
                    }, 1000);
                }
            });
        }
    }

    /**
     * Search links (<a>) in a frame and open them in browser or InAppBrowser if needed.
     * Only links that haven't been treated by the frame's Javascript will be treated.
     *
     * @param element Element to treat (iframe, embed, ...).
     * @param contentDocument The document of the element contents.
     */
    treatFrameLinks(element: any, contentDocument: Document): void {
        if (!contentDocument) {
            return;
        }

        contentDocument.addEventListener('click', (event) => {
            if (event.defaultPrevented) {
                // Event already prevented by some other code.
                return;
            }

            // Find the link being clicked.
            let el = <Element> event.target;
            while (el && el.tagName !== 'A') {
                el = el.parentElement;
            }

            const link = <CoreIframeHTMLAnchorElement> el;
            if (!link || link.treated) {
                return;
            }

            // Add click listener to the link, this way if the iframe has added a listener to the link it will be executed first.
            link.treated = true;
            link.addEventListener('click', this.linkClicked.bind(this, link, element));
        }, {
            capture: true // Use capture to fix this listener not called if the element clicked is too deep in the DOM.
        });
    }

    /**
     * Handle a window.open called by a frame.
     *
     * @param url URL passed to window.open.
     * @param name Name passed to window.open.
     * @param element HTML element of the frame.
     * @param navCtrl NavController to use if a link can be opened in the app.
     * @return Promise resolved when done.
     */
    protected async windowOpen(url: string, name: string, element?: any, navCtrl?: any): Promise<void> {
        const scheme = CoreUrlUtils.instance.getUrlScheme(url);
        if (!scheme) {
            // It's a relative URL, use the frame src to create the full URL.
            const src = element && (element.src || element.data);
            if (src) {
                const dirAndFile = CoreFile.instance.getFileAndDirectoryFromPath(src);
                if (dirAndFile.directory) {
                    url = CoreTextUtils.instance.concatenatePaths(dirAndFile.directory, url);
                } else {
                    this.logger.warn('Cannot get iframe dir path to open relative url', url, element);

                    return;
                }
            } else {
                this.logger.warn('Cannot get iframe src to open relative url', url, element);

                return;
            }
        }

        if (name == '_self') {
            // Link should be loaded in the same frame.
            if (!element) {
                this.logger.warn('Cannot load URL in iframe because the element was not supplied', url);

                return;
            }

            if (element.tagName.toLowerCase() == 'object') {
                element.setAttribute('data', url);
            } else {
                element.setAttribute('src', url);
            }
        } else if (CoreUrlUtils.instance.isLocalFileUrl(url)) {
            // It's a local file.
            const filename = url.substr(url.lastIndexOf('/') + 1);

            if (!CoreFileHelper.instance.isOpenableInApp({ filename })) {
                try {
                    await CoreFileHelper.instance.showConfirmOpenUnsupportedFile();
                } catch (error) {
                    return; // Cancelled, stop.
                }
            }

            try {
                await CoreUtils.instance.openFile(url);
            } catch (error) {
                CoreDomUtils.instance.showErrorModal(error);
            }
        } else {
            // It's an external link, check if it can be opened in the app.
            await CoreWindow.open(url, name, {
                navCtrl,
            });
        }
    }

    /**
     * A link inside a frame was clicked.
     *
     * @param link Data of the link clicked.
     * @param element Frame element.
     * @param event Click event.
     * @return Promise resolved when done.
     */
    protected async linkClicked(link: {href: string, target?: string}, element?: HTMLFrameElement | HTMLObjectElement,
            event?: Event): Promise<void> {
        if (event && event.defaultPrevented) {
            // Event already prevented by some other code.
            return;
        }

        const urlParts = CoreUrl.parse(link.href);
        if (!link.href || (urlParts.protocol && urlParts.protocol == 'javascript')) {
            // Links with no URL and Javascript links are ignored.
            return;
        }

        if (!CoreUrlUtils.instance.isLocalFileUrlScheme(urlParts.protocol, urlParts.domain)) {
            // Scheme suggests it's an external resource.
            event && event.preventDefault();

            const frameSrc = element && ((<HTMLFrameElement> element).src || (<HTMLObjectElement> element).data);

            // If the frame is not local, check the target to identify how to treat the link.
            if (element && !CoreUrlUtils.instance.isLocalFileUrl(frameSrc) && (!link.target || link.target == '_self')) {
                // Load the link inside the frame itself.
                if (element.tagName.toLowerCase() == 'object') {
                    element.setAttribute('data', link.href);
                } else {
                    element.setAttribute('src', link.href);
                }

                return;
            }

            // The frame is local or the link needs to be opened in a new window. Open in browser.
            if (!CoreSites.instance.isLoggedIn()) {
                CoreUtils.instance.openInBrowser(link.href);
            } else {
                await CoreSites.instance.getCurrentSite().openInBrowserWithAutoLoginIfSameSite(link.href);
            }
        } else if (link.target == '_parent' || link.target == '_top' || link.target == '_blank') {
            // Opening links with _parent, _top or _blank can break the app. We'll open it in InAppBrowser.
            event && event.preventDefault();

            const filename = link.href.substr(link.href.lastIndexOf('/') + 1);

            if (!CoreFileHelper.instance.isOpenableInApp({ filename })) {
                try {
                    await CoreFileHelper.instance.showConfirmOpenUnsupportedFile();
                } catch (error) {
                    return; // Cancelled, stop.
                }
            }

            try {
                await CoreUtils.instance.openFile(link.href);
            } catch (error) {
                CoreDomUtils.instance.showErrorModal(error);
            }
        } else if (CoreApp.instance.isIOS() && (!link.target || link.target == '_self') && element) {
            // In cordova ios 4.1.0 links inside iframes stopped working. We'll manually treat them.
            event && event.preventDefault();
            if (element.tagName.toLowerCase() == 'object') {
                element.setAttribute('data', link.href);
            } else {
                element.setAttribute('src', link.href);
            }
        }
    }
}

export class CoreIframeUtils extends makeSingleton(CoreIframeUtilsProvider) {}

/**
 * Subtype of HTMLAnchorElement, with some calculated data.
 */
type CoreIframeHTMLAnchorElement = HTMLAnchorElement & {
    treated?: boolean; // Whether the element has been treated already.
};