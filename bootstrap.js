/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cm = Components.manager;
const Cu = Components.utils;
const Cr = Components.results;

Cm.QueryInterface(Ci.nsIComponentRegistrar);

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/Services.jsm');

var baseURL = null;

/* Parts of the channel implementation are stolen from
 * browser/components/thumbnails/PageThumbsProtocol.js */
function ADBChannel(uri) {
  this._uri = uri;
  this.originalURI = uri;
}

ADBChannel.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIChannel, Ci.nsIRequest, Ci.nsIStreamListener]),
  /* nsIChannel */
  owner: null,
  notificationCallbacks: null,
  get securityInfo() null,
  contentType: null,
  contentCharset: null,
  contentLength: -1,
  get URI() this._uri,

  open: function ADBChannel_open() {
    throw (Components.returnCode = Cr.NS_ERROR_NOT_IMPLEMENTED);
  },

  asyncOpen: function ADBChannel_asyncOpen(listener, context) {
    if (this._isPending)
      throw (Components.returnCode = Cr.NS_ERROR_IN_PROGRESS);

    if (this._wasOpened)
      throw (Components.returnCode = Cr.NS_ERROR_ALREADY_OPENED);

    if (this._canceled)
      return (Components.returnCode = this._status);

    if (this._uri.scheme == 'adbview' && this._uri.path != '/')
      throw (Components.returnCode = Cr.NS_ERROR_FILE_NOT_FOUND);

    this._isPending = true;
    this._wasOpened = true;

    this._listener = listener;
    this._context = context;

    if (this.loadGroup)
      this.loadGroup.addRequest(this, null);

    if (this._canceled)
      return;

    var that = this;

    if (!this._uri.host)
      ADB.devices(function(devices) {
        that.contentType = 'application/http-index-format';
        var data = '300: ' + that._uri.scheme + ':///\n' +
                   '200: filename content-length last-modified file-type\n';
        for each (var d in devices) {
          if (d.status != 'offline')
            data += '201: ' + d.serial + ' 0 Thu,%201%20Jan%201970%2000:00:00%20GMT DIRECTORY\n';
        }
        that._pumpData(data);
      });
    else
      ADB.devices(function (devices) {
        var matching = [d for each (d in devices) if (d.serial.toLowerCase() == that._uri.host)];
        if (matching.length > 1) {
          that.onStopRequest(that, null, Cr.NS_ERROR_MALFORMED_URI);
          throw 'Ambiguous serial';
        }

        ADB.stat(matching[0].serial, that._uri.path, function (stat) {
          if (stat.mode & 0x4000)
            ADB.dirList(matching[0].serial, that._uri.path, function(dentries) {
              that.contentType = 'application/http-index-format';
              var data = '300: ' + that._uri.spec + '\n' +
                         '200: filename content-length last-modified file-type\n';
              for each (var d in dentries) {
                if (['.', '..'].every(function(n) n != d.name))
                  data += '201: ' + d.name + ' ' + d.size + ' ' + encodeURI(d.time.toUTCString()) + ' ' + (d.mode & 0x4000 ? 'DIRECTORY' : (d.mode & 0xa000 == 0xa000 ? 'SYMLINK' : 'FILE')) + '\n';
              }
              that._pumpData(data);
            });
          else {
            that.contentType = 'text/plain';
            that.contentLength = stat.size;
            var pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
            pipe.init(false, false, 0, 0, null);
            that._pumpStream(pipe.inputStream);
            ADB.getContent(matching[0].serial, that._uri.path, pipe.outputStream);
          }
        });
      });
  },

  /* nsIRequest */
  _status: Cr.NS_OK,
  _canceled: false,
  _isPending: false,

  get status() this._status,
  get name() this._uri.spec,
  loadFlags: Ci.nsIRequest.LOAD_NORMAL,
  loadGroup: null,

  isPending: function ADBChannel_isPending() this._isPending,

  cancel: function ADBChannel_cancel(status) {
    if (this._canceled)
      return;

    this._canceled = true;
    this._status = status;

    if (this._pump)
      this._pump.cancel(status);
  },

  suspend: function ADBChannel_suspend() {
    if (this._pump)
      this._pump.suspend();
  },

  resume: function ADBChannel_resume() {
    if (this._pump)
      this._pump.resume();
  },

  /* nsIStreamListener */
  onStartRequest: function ADBChannel_onStartRequest(request, context) {
    if (!this.canceled && Components.isSuccessCode(this._status))
      this._status = request.status;

    this._listener.onStartRequest(this, this._context);
  },

  onDataAvailable: function ADBChannel_onDataAvailable(request, context, instream, offset, count) {
    this._listener.onDataAvailable(this, this._context, instream, offset, count);
  },

  onStopRequest: function ADBChannel_onStopRequest(request, context, status) {
    this._isPending = false;
    this._status = status;

    this._listener.onStopRequest(this, this._context, status);
    this._listener = null;
    this._context = null;

    if (this.loadGroup)
      this.loadGroup.removeRequest(this, null, status);
  },

  /* private */
  _pumpStream: function ADBChannel_pumpStream(stream) {
    this._pump = Cc['@mozilla.org/network/input-stream-pump;1'].createInstance(Ci.nsIInputStreamPump);
    this._pump.init(stream, -1, -1, 0, 0, true);
    this._pump.asyncRead(this, null);
  },

  _pumpData: function ADBChannel_pumpData(data) {
    var stream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(Ci.nsIStringInputStream);
    stream.setData(data, data.length);
    this._pumpStream(stream);
  }
};

function GenericADBProtocolHandler() {}

GenericADBProtocolHandler.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIProtocolHandler]),
  defaultPort: -1,
  protocolFlags: Ci.nsIProtocolHandler.URI_IS_LOCAL_FILE |
                 Ci.nsIProtocolHandler.URI_NOAUTH |
                 Ci.nsIProtocolHandler.URI_IS_LOCAL_RESOURCE,

  allowPort: function ADBProtocolHandler_allowPort(port, scheme)
  {
    return false;
  },

  newURI: function ADBProtocolHandler_newURI(spec, charset, baseURI)
  {
    var uri = Cc['@mozilla.org/network/standard-url;1'].createInstance(Ci.nsIStandardURL);
    uri.init(Ci.nsIStandardURL.URLTYPE_AUTHORITY, -1, spec, charset, baseURI);
    return uri;
  }
};

function ADBProtocolHandler() {}

ADBProtocolHandler.prototype = new GenericADBProtocolHandler;
ADBProtocolHandler.prototype.classDescription = 'ADB Protocol Handler';
ADBProtocolHandler.prototype.classID = Components.ID('{f783fdc4-239a-4f5e-a7d9-c60874996c13}');
ADBProtocolHandler.prototype.contractID = '@mozilla.org/network/protocol;1?name=adb';
ADBProtocolHandler.prototype.scheme = 'adb';
ADBProtocolHandler.prototype.newChannel = function ADBProtocolHandler_newChannel(uri)
{
  return new ADBChannel(uri);
};

const ADBProtocolHandlerFactory = XPCOMUtils.generateNSGetFactory([ADBProtocolHandler])(ADBProtocolHandler.prototype.classID);

function ADBViewProtocolHandler() {}

ADBViewProtocolHandler.prototype = new GenericADBProtocolHandler;

ADBViewProtocolHandler.prototype.classDescription = 'ADB View Protocol Handler';
ADBViewProtocolHandler.prototype.classID = Components.ID('{cdd72632-8743-4532-8ff5-bd9ffd95f1b9}');
ADBViewProtocolHandler.prototype.contractID = '@mozilla.org/network/protocol;1?name=adbview';
ADBViewProtocolHandler.prototype.scheme = 'adbview';
ADBViewProtocolHandler.prototype.newChannel = function ADBViewProtocolHandler_newChannel(uri)
{
  if (!uri.host)
    return new ADBChannel(uri);
  var path;
  if (uri.path == '/') {
    path = baseURL + '/framebuffer.html';
  } else if (uri.path == '/adb.jsm') {
    path = baseURL + '/adb.jsm';
  } else {
    throw 'Error';
  }

  var channel = Services.io.newChannel(path, null, null);
  var principal = Services.scriptSecurityManager.getSystemPrincipal(uri);
  channel.originalURI = uri;
  channel.owner = principal;
  return channel;
};

ADBViewProtocolHandler.prototype.getURIFlags = function(uri)
{
  return Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT | Ci.nsIAboutModule.ALLOW_SCRIPT;
};

const ADBViewProtocolHandlerFactory = XPCOMUtils.generateNSGetFactory([ADBViewProtocolHandler])(ADBViewProtocolHandler.prototype.classID);

function startup(aData, aReason) {
  Cm.registerFactory(ADBProtocolHandler.prototype.classID,
                     ADBProtocolHandler.prototype.classDescription,
                     ADBProtocolHandler.prototype.contractID,
                     ADBProtocolHandlerFactory);
  Cm.registerFactory(ADBViewProtocolHandler.prototype.classID,
                     ADBViewProtocolHandler.prototype.classDescription,
                     ADBViewProtocolHandler.prototype.contractID,
                     ADBViewProtocolHandlerFactory);
  baseURL = aData.resourceURI.spec;
  Cu.import(baseURL + '/adb.jsm');
}

function shutdown(aData, aReason) {
  Cu.unload(baseURL + '/adb.jsm');
  Cm.unregisterFactory(ADBProtocolHandler.prototype.classID, ADBProtocolHandlerFactory);
  Cm.unregisterFactory(ADBViewProtocolHandler.prototype.classID, ADBViewProtocolHandlerFactory);
}
function install(aData, aReason) { }
function uninstall(aData, aReason) { }
