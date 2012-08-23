/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const CC = Components.Constructor;
const Cr = Components.results;
const Cu = Components.utils;
const BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
const Sts = Cc['@mozilla.org/network/socket-transport-service;1'].getService(Ci.nsISocketTransportService);

Cu.import("resource://gre/modules/Services.jsm");

let EXPORTED_SYMBOLS = ['ADB'];

function read_uint32(str, offset) {
  return str.charCodeAt(offset) + (str.charCodeAt(offset + 1) << 8) +
         (str.charCodeAt(offset + 2) << 16) + (str.charCodeAt(offset + 3) << 24);
}

let ADB = {
  /**
   * Returns a list of connected Android devices
   *
   * @param callback  A function to be called with a list of {serial, status}
   *                  pairs, where serial is the serial number that can be
   *                  used to address the device, and status one of "emulator",
   *                  "device" or "offline".
   */
  devices: function ADB_devices(callback) {
    var client = new ADBClient();
    client.serverRequest('host:devices', function (data) {
      function device_split(str) {
        [serial, status] = str.split('\t');
        return { serial: serial, status: status };
      }
      callback([device_split(d) for each (d in data.split('\n')) if (d)]);
    });
  },

  /**
   * Returns a directory listing on a given device
   *
   * @param serial    The device serial number
   * @param dir       The directory to list
   * @param callback  A function to be called ...
   */
  dirList: function ADB_devices(serial, dir, callback) {
    var dentries = [];
    var client = new ADBClient();
    client.syncRequest(serial, 'LIST', dir, function () {
      if (this._incoming.length < 20)
        return false;
      switch (this._incoming.substr(0, 4)) {
        case 'DONE':
          this._incoming = this._incoming.substr(20);
          this.close();
          callback(dentries);
          return false;
        case 'DENT':
          break;
        default:
          throw 'Unexpected entity: ' + this._incoming.substr(0, 4);
      }
      var length = read_uint32(this._incoming, 16);
      if (this._incoming.length < length + 20)
        return false;
      var mode = read_uint32(this._incoming, 4);
      var size = read_uint32(this._incoming, 8);
      var time = read_uint32(this._incoming, 12);
      dentries.push({ name: this._incoming.substr(20, length),
                      mode: mode, size: size, mtime: new Date(time * 1000) });
      this._incoming = this._incoming.substr(length + 20);
      return true;
    });
  },

  /**
   * Returns file stat for the given path on the given device.
   *
   * @param serial    The device serial number.
   * @param path      The path to get stat for.
   * @param callback  A function to be called ...
   */
  stat: function ADB_stat(serial, path, callback) {
    var client = new ADBClient();
    client.syncRequest(serial, 'STAT', path, function () {
      if (this._incoming.length < 16)
        return false;
      if (this._incoming.substr(0, 4) != 'STAT')
        throw 'Unexpected entity: ' + this._incoming.substr(0, 4);
      var mode = read_uint32(this._incoming, 4);
      var size = read_uint32(this._incoming, 8);
      var time = read_uint32(this._incoming, 12);
      this._incoming = this._incoming.substr(16);
      callback({ mode: mode, size: size, mtime: new Date(time * 1000) });
      return true;
    });
  },

  /**
   * Get contents from a given file on the given device.
   *
   * @param serial    The device serial number.
   * @param path      The path to get stat for.
   * @param output    An nsIOutputStream that will receive the file content.
   */
  getContent: function ADB_getContent(serial, path, output) {
    var client = new ADBClient();
    client.syncRequest(serial, 'RECV', path, function () {
      if (this._incoming.length < 8)
        return false;
      switch (this._incoming.substr(0, 4)) {
        case 'DONE':
          this._incoming = this._incoming.substr(8);
          output.close();
          this.close();
          return false;
        case 'DATA':
          break;
        default:
          throw 'Unexpected entity: ' + this._incoming.substr(0, 4);
      }
      var length = read_uint32(this._incoming, 4);
      if (this._incoming.length < length + 8)
        return false;
      output.write(this._incoming.substr(8, length), length);
      this._incoming = this._incoming.substr(length + 8);
      return true;
    });
  },

  getFrameBuffer: function ADB_getFrameBuffer(serial, callback) {
    var client = new ADBClient();
    client.connectDeviceService(serial, 'framebuffer:', function () {
      if (this._incoming.length < 4)
        return false;
      var foo = '';
      for (var i = 0; i < this._incoming.length; i++)
        foo += this._incoming.charCodeAt(i) + ' ';
      var version = read_uint32(this._incoming, 0);
      if (version != 1)
        throw 'Unsupported framebuffer version: ' + version;
      if (this._incoming.length < 52)
        return false;
      var size = read_uint32(this._incoming, 8);
      if (this._incoming.length < size + 52)
        return false;
      var image = {
        size: size,
        depth: read_uint32(this._incoming, 4),
        width: read_uint32(this._incoming, 12),
        height: read_uint32(this._incoming, 16),
        redOffset: read_uint32(this._incoming, 20),
        redWidth: read_uint32(this._incoming, 24),
        blueOffset: read_uint32(this._incoming, 28),
        blueWidth: read_uint32(this._incoming, 32),
        greenOffset: read_uint32(this._incoming, 36),
        greenWidth: read_uint32(this._incoming, 40),
        alphaOffset: read_uint32(this._incoming, 44),
        alphaWidth: read_uint32(this._incoming, 48),
        data: this._incoming.substr(52, size)
      };
      this._incoming = this._incoming.substr(size + 52);
      callback(image);
      return true;
    });
  },

  getDebuggerTransport: function ADB_getDebuggerTransport(serial, host, port) {
    var service = (host == 'localhost') ? 'tcp:' + port : 'tcp:' + port + ':' + host;
    var client = new ADBClient();
    var tmp = {};
    Cu.import('resource://gre/modules/devtools/dbg-client.jsm', tmp);
    client.ready = function() {
      client.send = tmp.DebuggerTransport.prototype.send;
    };
    client.connectDeviceService(serial, service, function () {
      this._converter = Cc['@mozilla.org/intl/scriptableunicodeconverter'].createInstance(Ci.nsIScriptableUnicodeConverter);
      this._converter.charset = 'UTF-8';
      this._processIncoming = tmp.DebuggerTransport.prototype._processIncoming;
      this._nextHandlers.push(this._processIncoming);
      this.onDataAvailable = tmp.DebuggerTransport.prototype.onDataAvailable;
      return true;
    });
    return client;
  }
};

function pickADBExecutable() {
  var filePicker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
  filePicker.init(Services.wm.getMostRecentWindow(null), 'Select adb location', Ci.nsIFilePicker.modeOpen);
  var filter = (Services.appinfo.OS == 'WINNT') ? 'adb.exe' : 'adb';
  filePicker.appendFilter(filter, filter);
  if (filePicker.show() == Ci.nsIFilePicker.returnOK) {
    Services.prefs.setCharPref('extensions.adb4ff@glandium.org.adb', filePicker.file.path);
    return filePicker.file;
  } else {
    // Cancel
  }
}

function startADBServer() {
  var adb;
  try {
    var file = Services.prefs.getCharPref('extensions.adb4ff@glandium.org.adb');
    adb = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
    adb.initWithPath(file);
  } catch(e) {
    adb = pickADBExecutable();
  }
  while (true) {
    var process = Cc['@mozilla.org/process/util;1'].createInstance(Ci.nsIProcess);
    try {
      process.init(adb);
      process.run(true, ['start-server'], 1);
      return;
    } catch(e) {
      adb = pickADBExecutable();
    }
  }
}

/* Inspired by and compatible with DebuggerTransport */
const ADB_SERVER_MODE = 1;
const ADB_DEVICE_MODE = 2;
const ADB_SYNC_MODE = 3;

function ADBClient() {
  this._connected = false;
  this._mode = ADB_SERVER_MODE;
  this._incomingHandler = null;
  this._nextHandlers = [];
  this._incoming = '';
  this._outgoing = '';
  this._connect();
}

ADBClient.prototype = {
  _connect: function ADBClient_connect() {
    var that = this;
    var transport = Sts.createTransport(null, 0, 'localhost', 5037, null);
    transport.setEventSink({ onTransportStatus: function (transport, status, progress, progressmax) {
        if (status == Ci.nsISocketTransport.STATUS_CONNECTED_TO) {
          that._connected = true;
          that._flushOutgoing();
        }
      }
    }, Services.tm.currentThread);
    this._input = transport.openInputStream(0 /* No flags */, 0, 0);
    this._output = transport.openOutputStream(0 /* No flags */, 0, 0);
    var pump = Cc['@mozilla.org/network/input-stream-pump;1'].createInstance(Ci.nsIInputStreamPump);
    pump.init(this._input, -1, -1, 0, 0, false);
    pump.asyncRead(this, null);
  },

  sendData: function ADBClient_sendData(payload, callback) {
    this._outgoing += payload;
    this._flushOutgoing();
    if (callback)
      this._nextHandlers.push(callback);
  },

  serverString: function ADBClient_serverString(string) {
    return ('000' + string.length.toString(16)).substr(-4) + string;
  },

  close: function ADBClient_close() {
    this._input.close();
    this._output.close();
  },

  _flushOutgoing: function ADBClient_flushOutgoing() {
    if (this._connected && this._outgoing.length > 0)
      this._output.asyncWait(this, 0, 0, Services.tm.currentThread);
  },

  onOutputStreamReady: function ADBClient_onOutputStreamReady(stream) {
    var written = stream.write(this._outgoing, this._outgoing.length);
    this._outgoing = this._outgoing.substr(written);
    this._flushOutgoing();
  },

  onStartRequest: function ADBClient_onStartRequest(request, context) {},

  onStopRequest: function ADBClient_onStopRequest(request, context, status) {
    this.close();
    if (status != Cr.NS_OK && !this._connected) {
      startADBServer();
      this._connect();
    }
  },

  onDataAvailable: function ADBClient_onDataAvailable(request, context, stream, offset, count) {
    try {
      var bin = new BinaryInputStream(this._input);
      this._incoming += bin.readBytes(count);
      do {
        if (this._nextHandlers.length)
          this._incomingHandler = this._nextHandlers.shift();
      } while (this._incomingHandler && this._incomingHandler());
    } catch (e) {
      Cu.reportError(e);
      this.close();
    }
  },

  readServerStatus: function ADBClient_readServerStatus() {
    if (this._incoming.length < 4)
      return false;
    switch (this._incoming.substr(0, 4)) {
      case 'OKAY':
        break;
      case 'FAIL':
        this._nextHandlers.unshift(this.serverErrorHandler);
        break;
      default:
        throw 'Unsupported response from ADB server: ' + this._incoming.substr(0, 4);
    }
    this._incoming = this._incoming.substr(4);
    return true;
  },

  serverErrorHandler: function ADBClient_serverErrorHandler() {
    var string = this.readServerString();
    if (string === false)
      return false;
    throw "ADB Server Error: " + string;
  },

  readServerString: function ADBClient_readServerString() {
    if (this._incoming.length < 4)
      return false;
    var length = parseInt(this._incoming.substr(0, 4), 16);
    if (this._incoming.length < length + 4)
      return false;
    var string = this._incoming.substr(4, length);
    this._incoming = this._incoming.substr(length + 4);
    return string;
  },

  serverRequest: function ADBClient_serverRequest(request, callback) {
    if (this._mode != ADB_SERVER_MODE)
      throw 'ADB client not connected to server';

    this.sendData(this.serverString(request), function () {
      var data = this.readServerStatus() && this.readServerString();
      if (data === false)
        return false;
      callback(data);
      return true;
    });
  },

  connectDeviceService: function ADBClient_connectDeviceService(serial, service, handler) {
    if (this._mode != ADB_SERVER_MODE)
      throw 'ADB client not connected to server';

    this._mode = ADB_DEVICE_MODE;
    this.sendData(this.serverString('host:transport:' + serial), function () {
      if (!this.readServerStatus())
        return false;
      this.sendData(this.serverString(service), function () {
        if (!this.readServerStatus())
          return false;
        this._nextHandlers.push(handler);
        return true;
      });
    });
  },

  syncRequest: function ADBClient_syncRequest(serial, request, dir, handler) {
    this.connectDeviceService(serial, 'sync:', function () {
      if (this._mode != ADB_DEVICE_MODE)
        throw 'ADB client not connected to device';

      this._mode = ADB_SYNC_MODE;
      var l = dir.length;
      var le_length = String.fromCharCode((l & 0xff), (l & 0xff00) >> 8,
                                          (l & 0xff0000) >> 16,
                                          (l & 0xff000000) >> 24);
      this.sendData(request + le_length + dir, handler);
    });
  },
};
