/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import('resource://gre/modules/Services.jsm');

let gArgs;

function dialogOnLoad() {
  gArgs = window.arguments[0].QueryInterface(Ci.nsIWritablePropertyBag);

  document.title = gArgs.getProperty('title');
  document.getElementById('remote-label').setAttribute('value', gArgs.getProperty('prompt'));
  document.getElementById('remote').setAttribute('value', gArgs.getProperty('remoteHost') + ':' + gArgs.getProperty('remotePort'));

  // The following is stolen from selectDialog.js

  // Default to canceled.
  gArgs.setProperty("ok", false);

  // resize the window to the content
  window.sizeToContent();

  // Move to the right location
  moveToAlertPosition();
  centerWindowOnScreen();

  // play sound
  try {
    Cc["@mozilla.org/sound;1"].
    createInstance(Ci.nsISound).
    playEventSound(Ci.nsISound.EVENT_SELECT_DIALOG_OPEN);
  } catch(e) { } 
}

function dialogOK() {
  gArgs.setProperty('device', document.getElementById('device').value);
  var remote = document.getElementById('remote').value;
  var parts;
  if ((parts = remote.split(":")).length == 2) {
    var [host, port] = parts;
    if (host.length && port.length) {
      gArgs.setProperty('remoteHost', host);
      gArgs.setProperty('remotePort', port);
      gArgs.setProperty("ok", true);
      return true;
    }
  }
  return false;
}

function refreshDevices(element) {
  var count = element.itemCount;
  var items = [];
  for (var i = 1; i < count; i++) {
    items[i] = element.getItemAtIndex(i);
  }

  Cu.import(gArgs.getProperty('baseURL') + '/adb.jsm');

  ADB.devices(function (devices) {
    for each (var d in devices) {
      if (items.every(function(n) n.value != d.serial)) {
        element.appendItem(d.serial, d.serial);
      }
    }
    for each (var i in items) {
      if (devices.every(function(n) n.serial != i.value)) {
        element.removeItemAt(element.getIndexOfItem(i));
      }
    }
  });
}

function switchDevice(element) {
  var selected = element.selectedItem;
  var host;
  if (selected.value == 'local') {
    host = gArgs.getProperty('remoteHost');
  } else {
    host = 'localhost';
  }
  document.getElementById('remote').value = host + ':' + gArgs.getProperty('remotePort');
}
