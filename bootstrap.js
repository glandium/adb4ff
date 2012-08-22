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

var convert5to8 = [];
for (var i = 0; i < Math.pow(2, 5); i++)
  convert5to8[i] = (i * 527 + 23) >> 6;
var convert6to8 = [];
for (var i = 0; i < Math.pow(2, 6); i++)
  convert6to8[i] = (i * 259 + 33) >> 6;

function mulTableFor(width) {
  if (width == 5)
    return convert5to8;
  if (width == 6)
    return convert6to8;
  throw 'Unsupported';
}

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
      this._devicesList();
    else
      ADB.devices(function (devices) {
        var matching = [d for each (d in devices) if (d.serial.toLowerCase() == that._uri.host)];
        if (matching.length > 1) {
          that.onStopRequest(that, null, Cr.NS_ERROR_MALFORMED_URI);
          throw 'Ambiguous serial';
        }

        if (that._uri.scheme == 'adb')
          ADB.stat(matching[0].serial, that._uri.path, function (stat) {
            if (stat.mode & 0x4000)
              that._directoryIndex(matching[0].serial, that._uri.path);
            else
              that._fileContents(matching[0].serial, that._uri.path, stat.size);
          });
        else
          ADB.getFrameBuffer(matching[0].serial, function (image) {
            var encoder = Cc['@mozilla.org/image/encoder;2?type=image/png'].createInstance().QueryInterface(Ci.imgIEncoder);
            if (image.depth == 32 &&
                image.redOffset == 0 && image.redWidth == 8 &&
                image.greenOffset == 8 && image.greenWidth == 8 &&
                image.blueOffset == 16 && image.blueWidth == 8 &&
                image.alphaOffset == 24 && image.alphaWidth == 8) {
              var data = new Array(image.size);
              for (var i = 0; i < image.size; i++) { data[i] = image.data.charCodeAt(i); }
              encoder.initFromData(data, image.width * image.height * 4, image.width, image.height, image.width * 4, Ci.imgIEncoder.INPUT_FORMAT_RGBA, '');
            } else if (image.depth == 16 && image.alphaWidth == 0) {
              var redShift = image.redOffset;
              var greenShift = image.greenOffset;
              var blueShift = image.blueOffset;
              var redMask = (Math.pow(2, image.redWidth) - 1) << redShift;
              var greenMask = (Math.pow(2, image.greenWidth) - 1) << greenShift;
              var blueMask = (Math.pow(2, image.blueWidth) - 1) << blueShift;
              var redMul = mulTableFor(image.redWidth);
              var greenMul = mulTableFor(image.greenWidth);
              var blueMul = mulTableFor(image.blueWidth);
              var data = new Array(image.width * image.height * 3);
              for (var i = 0; i < image.size / 2; i++) {
                var pixel = image.data.charCodeAt(i * 2) + (image.data.charCodeAt(i * 2 + 1) << 8);
                data[i * 3] = redMul[(pixel & redMask) >> redShift];
                data[i * 3 + 1] = greenMul[(pixel & greenMask) >> greenShift];
                data[i * 3 + 2] = blueMul[(pixel & blueMask) >> blueShift];
              }
              encoder.initFromData(data, image.width * image.height * 3, image.width, image.height, image.width * 3, Ci.imgIEncoder.INPUT_FORMAT_RGB, '');
            }
            that.contentType = 'image/png';
            that._pumpStream(encoder);
          });
      });
  },

  _generateIndex: function ADBChannel_generateIndex(title, files) {
    this.contentType = 'application/http-index-format';
    var data = '300: ' + title + '\n' +
               '200: filename content-length last-modified file-type\n';
    for each (var f in files) {
      data += '201: ' + f.name + ' ' + f.size + ' ' + encodeURI(f.mtime.toUTCString()) + ' ' + (f.mode & 0x4000 ? 'DIRECTORY' : (f.mode & 0xa000 == 0xa000 ? 'SYMLINK' : 'FILE')) + '\n';
    }
    this._pumpData(data);
  },

  _devicesList: function ADBChannel_devicesList() {
    var that = this;
    ADB.devices(function(devices) {
      that._generateIndex(that._uri.scheme + ':///', [{name: d.serial, size: 0, mtime: new Date(0), mode: 0x4000} for each (d in devices) if (d.status != 'offline')]);
    });
  },

  _directoryIndex: function ADBChannel_directoryIndex(device, path) {
    var that = this;
    ADB.dirList(device, path, function(dentries) {
      that._generateIndex(path, [d for each (d in dentries) if (['.', '..'].every(function(n) n != d.name))]);
    });
  },

  _fileContents: function ADBChannel_fileContents(device, path, size) {
    this.contentType = 'text/plain';
    this.contentLength = size;
    var pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
    pipe.init(false, false, 0, 0, null);
    this._pumpStream(pipe.inputStream);
    ADB.getContent(device, path, pipe.outputStream);
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

  newChannel: function ADBProtocolHandler_newChannel(uri)
  {
    return new ADBChannel(uri);
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

const ADBProtocolHandlerFactory = XPCOMUtils.generateNSGetFactory([ADBProtocolHandler])(ADBProtocolHandler.prototype.classID);

function ADBViewProtocolHandler() {}

ADBViewProtocolHandler.prototype = new GenericADBProtocolHandler;

ADBViewProtocolHandler.prototype.classDescription = 'ADB View Protocol Handler';
ADBViewProtocolHandler.prototype.classID = Components.ID('{cdd72632-8743-4532-8ff5-bd9ffd95f1b9}');
ADBViewProtocolHandler.prototype.contractID = '@mozilla.org/network/protocol;1?name=adbview';
ADBViewProtocolHandler.prototype.scheme = 'adbview';

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
