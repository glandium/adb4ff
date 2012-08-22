/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const CC = Components.Constructor;
const Cr = Components.results;
const BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
const Sts = Cc['@mozilla.org/network/socket-transport-service;1'].getService(Ci.nsISocketTransportService);

Components.utils.import("resource://gre/modules/Services.jsm");

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
    client.hostRequest('host:devices', function (data) {
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

    function read_dentry() {
      this.read(20, function (data) {
        if (data.substr(0, 4) == 'DONE')
          callback(dentries);
        else if (data.substr(0, 4) != 'DENT')
          throw 'Unexpected entity';
        var mode = read_uint32(data, 4);
        var size = read_uint32(data, 8);
        var time = read_uint32(data, 12);
        var length = read_uint32(data, 16);
        this.read(length, function (data) {
          dentries.push({ name: data, mode: mode, size: size, mtime: new Date(time * 1000) });
          read_dentry.call(this);
        });
      });
    }

    var client = new ADBClient();
    client.hostService('host:transport:' + serial, function () {
      this.hostService('sync:', function () {
        this.syncRequest('LIST', dir, function () {
          read_dentry.call(this);
        });
      });
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
    client.hostService('host:transport:' + serial, function () {
      this.hostService('sync:', function () {
        this.syncRequest('STAT', path, function () {
          this.read(16, function (data) {
            if (data.substr(0, 4) != 'STAT')
              throw 'Unexpected entity';
            var mode = read_uint32(data, 4);
            var size = read_uint32(data, 8);
            var time = read_uint32(data, 12);
            callback.call(this, { mode: mode, size: size, mtime: new Date(time * 1000) });
          });
        });
      });
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
    function read_data() {
      this.read(8, function (data) {
        if (data.substr(0, 4) == 'DONE')
          output.close();
        else if (data.substr(0, 4) != 'DATA')
          throw 'Unexpected entity';
        var size = read_uint32(data, 4);
        this.read(size, function (data) {
          output.write(data, data.length);
          read_data.call(this);
        });
      });
    }

    var client = new ADBClient();
    client.hostService('host:transport:' + serial, function () {
      this.hostService('sync:', function () {
        this.syncRequest('RECV', path, function () {
          read_data.call(this);
        });
      });
    });
  },

  getFrameBuffer: function ADB_getFrameBuffer(serial, callback) {
    var client = new ADBClient();
    client.hostService('host:transport:' + serial, function () {
      this.hostService('framebuffer:', function () {
        this.read(4, function(data) {
          var version = read_uint32(data, 0);
          if (version != 1)
            throw 'Unsupported';
          this.read(48, function (data) {
            var image = {
              depth: read_uint32(data, 0),
              size: read_uint32(data, 4),
              width: read_uint32(data, 8),
              height: read_uint32(data, 12),
              redOffset: read_uint32(data, 16),
              redWidth: read_uint32(data, 20),
              blueOffset: read_uint32(data, 24),
              blueWidth: read_uint32(data, 28),
              greenOffset: read_uint32(data, 32),
              greenWidth: read_uint32(data, 36),
              alphaOffset: read_uint32(data, 40),
              alphaWidth: read_uint32(data, 44)
            };
            this.read(image.size, function (data) {
              image.data = data;
              callback.call(this, image);
            });
          });
        });
      });
    });
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

function ADBClient() {
  this.connected = false;
}

ADBClient.prototype = Object.freeze({
  _connect: function ADBClient_connect(callback) {
    var that = this;
    var transport = Sts.createTransport(null, 0, 'localhost', 5037, null);
    transport.setEventSink({ onTransportStatus: function (transport, status, progress, progressmax) {
        if (status == Ci.nsISocketTransport.STATUS_CONNECTED_TO) {
          that.connected = true;
          callback.call(that);
        }
      }
    }, Services.tm.currentThread);
    this.input = transport.openInputStream(0 /* No flags */, 0, 0);
    this.input.asyncWait({ onInputStreamReady: function(input) {
        try {
          input.available();
        } catch(e) {
          if (e.result != Cr.NS_BASE_STREAM_CLOSED) {
            startADBServer();
            that._connect(callback);
            return;
          }
        }
      }
    }, 0, 0, Services.tm.currentThread);
    this.output = transport.openOutputStream(0 /* No flags */, 0, 0);
  },

  /**
   * Opens a service on the ADB host
   *
   * @param service   The service to connect to.
   * @param callback  A function to be called when the connection is setup
   *                   In the callback, 'this' is the ADBClient object.
   */
  hostService: function ADBClient_hostService(service, callback) {
    if (this.connected) {
      this._hostService(service, callback);
      return;
    }
    this._connect(function () {
      this._hostService(service, callback);
    });
  },

  _hostService: function ADBClient__hostService(service, callback) {
    this.writeString(service, function () {
      this.read(4, function (data) {
        switch (data) {
          case "OKAY":
            callback.call(this);
            break;
          case "FAIL":
            this.readString(function (str) {
              Services.console.logStringMessage(str);
              throw str;
            });
            break;
          default:
            Services.console.logStringMessage("Unsupported response from ADB server");
            throw "Unsupported response from ADB server";
        }
      });
    });
  },

  /**
   * Performs a request to the ADB host
   *
   * @param request   The request to perform.
   * @param callback  A function to be called with the response content.
   */
  hostRequest: function ADBClient_hostRequest(request, callback) {
    this.hostService(request, function () {
      this.readString(callback);
    });
  },

  /**
   * Performs a 'sync:' request to the ADB daemon on the device
   *
   * @param request    The request to perform.
   * @param dir        The directory on which to apply it.
   * @param callback   A function to call ...
   */
  syncRequest: function ADBClient_syncRequest(request, dir, callback) {
    var l = dir.length;
    var le_length = String.fromCharCode((l & 0xff), (l & 0xff00) >> 8,
                                        (l & 0xff0000) >> 16,
                                        (l & 0xff000000) >> 24);
    this.write(request + le_length + dir, callback);
  },

  /**
   * Reads length amount of data from the ADB server connection, and calls
   * the given callback with the data once completely read.
   *
   * @params length    Amount of data to be read.
   * @params callback  A function to call when data is completely read.
   *                   In the callback, 'this' is the ADBClient object.
   *                   The callback is called with the read data as argument.
   */
  read: function ADBClient_read(length, callback) {
    if (!length)
      return;
    if ('buf' in this)
      throw 'Cannot read now';
    this.buf = [];
    this.callback = callback;
    this.length = length;
    this.input.asyncWait(this, 0, length, Services.tm.currentThread);
  },

  /**
   * Helper to read a string in the ADB host format: 4 hex digits giving
   * the string length, followed by the string.
   *
   * @params callback  A function to call when the string is completely read.
   *                   In the callback, 'this' is the ADBClient object.
   *                   The callback is called with the read data as argument.
   */
  readString: function ADBClient_readString(callback) {
    this.read(4, function (data) {
      var length = parseInt(data, 16);
      this.read(length, function (data) {
        callback(data);
      });
    });
  },

  /**
   * Writes given data to the ADB server connection, and calls the given
   * callback once completely written.
   *
   * @params data      Data to be written.
   * @params callback  A function to call when data is completely written.
   *                   In the callback, this is the ADBClient object.
   */
  write: function ADBClient_write(data, callback) {
    if ('buf' in this)
      throw 'Cannot write now';
    this.buf = data;
    this.callback = callback;
    this.output.asyncWait(this, 0, this.buf.length, Services.tm.currentThread);
  },

  /**
   * Helper to write a string in the ADB host format: 4 hex digits giving
   * the string length, followed by the string.
   *
   * @params data      Data to be written.
   * @params callback  A function to call when the string is completely written.
   *                   In the callback, 'this' is the ADBClient object.
   */
  writeString: function ADBClient_writeString(data, callback) {
    var payload = ('000' + data.length.toString(16)).substr(-4)
                  + data;
    this.write(payload, callback);
  },

  /**
   * nsIAsyncOutputStream.asyncWait handler.
   */
  onOutputStreamReady: function ADBClient_onOutputStreamReady(output)
  {
    var len = this.output.write(this.buf, this.buf.length);
    if (len != this.buf.length) {
      this.buf = this.buf.substring(len);
      this.output.asyncWait(this, 0, this.buf.length, Services.tm.currentThread);
    } else {
      delete this.buf;
      this.callback.call(this);
    }
  },

  /**
   * nsIAsyncInputStream.asyncWait handler.
   */
  onInputStreamReady: function ADBClient_onInputStreamReady(input)
  {
    var len = 0;
    try { len = input.available(); } catch(e) { }
    var bin = new BinaryInputStream(input);
    if (len > this.length)
      len = this.length;
    this.buf += bin.readBytes(len);
    this.length -= len;

    if (this.length) {
      this.input.asyncWait(this, 0, this.length, Services.tm.currentThread);
      return;
    }

    var data = this.buf;
    delete this.buf;
    this.callback.call(this, data);
  }
});
