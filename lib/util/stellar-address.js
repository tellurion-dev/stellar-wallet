var Stex       = require("stex");
var _          = Stex._;
var KeyPair    = require("stellar-lib/src/js/ripple/keypair").KeyPair; //HACK: until we update stellar-lib to expose it
var StellarBase = require('stellar-base');

module.exports.addressFromPublicKey = function(publicKeyString) {
  var buffer = new Buffer(publicKeyString, 'base64');
  var keyPair = new KeyPair();
  keyPair._pubkey = buffer;
  return keyPair.get_address().to_json();
};

module.exports.newAddressFromPublicKey = function(publicKeyString) {
  var publicKeyBytes = new Buffer(publicKeyString, "base64");
  var keyPair = new StellarBase.Keypair({publicKey: publicKeyBytes});
  return keyPair.address();
};
