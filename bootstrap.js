/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cm = Components.manager;
const Cu = Components.utils;

Cm.QueryInterface(Ci.nsIComponentRegistrar);

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/Services.jsm');

var baseURL = null;

function ADBProtocolHandler() {}

ADBProtocolHandler.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIProtocolHandler]),
  classDescription: 'ADB Protocol Handler',
  classID: Components.ID('{f783fdc4-239a-4f5e-a7d9-c60874996c13}'),
  contractID: '@mozilla.org/network/protocol;1?name=adb',

  scheme: 'adb',
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
    if (!uri.host) {
      var channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);
      var pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
      pipe.init(true, false, 0, 0, null);
      channel.setURI(uri);
      channel.contentStream = pipe.inputStream;
      channel.QueryInterface(Ci.nsIChannel);
      channel.contentType = 'application/http-index-format';
      ADB.devices(function(devices) {
        var data = '300: adb:///\n' +
                   '200: filename content-length last-modified file-type\n';
        for each (var d in devices) {
          if (d.status != 'offline')
            data += '201: ' + d.serial + ' 0 Thu,%201%20Jan%201970%2000:00:00%20GMT DIRECTORY\n';
        }

        pipe.outputStream.write(data, data.length);
        pipe.outputStream.close();
      });
      return channel;
    } else {
      var channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);
      var pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
      pipe.init(true, false, 0, 0, null);
      channel.setURI(uri);
      channel.contentStream = pipe.inputStream;
      channel.QueryInterface(Ci.nsIChannel);
      ADB.devices(function (devices) {
        var matching = [d for each (d in devices) if (d.serial.toLowerCase() == uri.host)];
        if (matching.length > 1)
          throw 'Ambiguous serial';

        ADB.stat(matching[0].serial, uri.path, function (stat) {
          if (stat.mode & 0x4000)
            ADB.dirList(matching[0].serial, uri.path, function(dentries) {
              channel.contentType = 'application/http-index-format';
              var data = '300: ' + uri.spec + '\n' +
                         '200: filename content-length last-modified file-type\n';
              for each (var d in dentries) {
                if (['.', '..'].every(function(n) n != d.name))
                  data += '201: ' + d.name + ' ' + d.size + ' ' + encodeURI(d.time.toUTCString()) + ' ' + (d.mode & 0x4000 ? 'DIRECTORY' : (d.mode & 0xa000 == 0xa000 ? 'SYMLINK' : 'FILE')) + '\n';
              }

              pipe.outputStream.write(data, data.length);
              pipe.outputStream.close();
            });
          else {
            channel.contentLength = stat.size;
            ADB.getContent(matching[0].serial, uri.path, pipe.outputStream);
          }
        });
      });
      return channel;
    }
  },

  newURI: function ADBProtocolHandler_newURI(spec, charset, baseURI)
  {
    var uri = Cc['@mozilla.org/network/standard-url;1'].createInstance(Ci.nsIStandardURL);
    uri.init(Ci.nsIStandardURL.URLTYPE_AUTHORITY, -1, spec, charset, baseURI);
    return uri;
  }
};

const ADBProtocolHandlerFactory = XPCOMUtils.generateNSGetFactory([ADBProtocolHandler])(ADBProtocolHandler.prototype.classID);

function startup(aData, aReason) {
  Cm.registerFactory(ADBProtocolHandler.prototype.classID,
                     ADBProtocolHandler.prototype.classDescription,
                     ADBProtocolHandler.prototype.contractID,
                     ADBProtocolHandlerFactory);
  baseURL = aData.resourceURI.spec;
  Cu.import(baseURL + '/adb.jsm');
}

function shutdown(aData, aReason) {
  Cu.unload(baseURL + '/adb.jsm');
  Cm.unregisterFactory(ADBProtocolHandler.prototype.classID, ADBProtocolHandlerFactory);
}
function install(aData, aReason) { }
function uninstall(aData, aReason) { }
