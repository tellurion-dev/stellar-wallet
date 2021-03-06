var Stex       = require('stex');
var errors     = Stex.errors;
var _          = Stex._;
var hash       = require("../../util/hash");
var signedJson = require("../../util/signed-json");
var validate   = require("../../util/validate");
var walletV2   = require("../../models/wallet-v2");
var lockout    = require("../../models/lockout");
var totp       = require("../../util/totp");
var scmp       = require('scmp');
var Promise    = Stex.Promise;
var usernameProofs = require("../../util/username-proofs");

var wallets = module.exports;

//NOTE: this varies from the v1 lockoutByIP... we respond with a forbidden error
var lockoutByIP = lockout.middleware(
  function(req, res) { return req.ip; },
  function(req, res) { failForbidden(res); }
);
  
wallets.showLoginParams = function(req, res, next) {
  walletV2.getLoginParams(req.body.username)
    .then(function(loginParams) {
      res.send(loginParams);
    })
    .catch(errors.RecordNotFound, function(err) {
      failMissing(res);
    });
};

wallets.getLockVersion = signedJson.action(function(req, res, next) {
  var body = req.verified.body;
  walletV2.getByWalletId(req.verified.username, req.verified.walletId)
    .then(function(wallet) {
      res.send({lockVersion: wallet.lockVersion});
    })
    .catch(errors.RecordNotFound, function(err) {
      lockout.record(req.ip);
      failMissing(res);
    });
});

wallets.show = [lockoutByIP, function(req, res, next) {
  return walletV2.getWithAuthorization(req.body.username, req.body.walletId, req.body.totpCode)
    .then(function(wallet) {
      res.send(_.pick(wallet, "lockVersion", "mainData", "keychainData", "updatedAt"));
    })
    .catch(
      errors.RecordNotFound, 
      errors.Forbidden, 
      function(err) {
        lockout.record(req.ip);
        failForbidden(res);
      });
}];

wallets.create = function(req, res, next) {
  var attrs = _.pick(req.body, [
    "username",
    "walletId",
    "salt", 
    "kdfParams",
    "publicKey",
    "mainData",
    "mainDataHash",
    "keychainData",
    "keychainDataHash",
    "usernameProof"
  ]);

  attrs.walletId = new Buffer(attrs.walletId || "", 'base64');

  walletV2.create(attrs)
    .then (function(walletV2) {
      res.send({"status" : "success", "newLockVersion": 0}); 
    })
    .catch(
      errors.DuplicateRecord,
      usernameProofs.errors.NonMatchingPublicKey,
      usernameProofs.errors.AddressNotFromPublicKey,
      usernameProofs.errors.InvalidClaim,
      function(err) {
        fail(res, {field:"username", code:"already_taken"});
      })
    .catch(validate.errors.MissingField,    fieldFailer("missing", res))
    .catch(validate.errors.NotJson,         fieldFailer("invalid_json", res))
    .catch(validate.errors.InvalidHash,     fieldFailer("invalid_hash", res))
    .catch(validate.errors.InvalidUsername, fieldFailer("invalid_username", res))
    .catch(validate.errors.InvalidLength,   fieldFailer("invalid_length", res))
    .catch(next);
};

wallets.update = signedJson.action(function(req, res, next) {
  var body = req.verified.body;
  /*
   * This method handles two situations:
   *
   * * User changes a password after recovery
   *   It this situation all `changePasswordParams` must be provided because all of them (except
   *   `salt` and `kdfParams`) are derived or encrypted by user's masterKey which is derived
   *   from password.
   * * User updates `mainData`
   *   Only `mainData` and `mainDataHash` must be provided.
   */

  var fetchParams = function(params) {
    return function() {
      // Lock version needed in both scenarios
      params.push('lockVersion');
      if (_.keys(body).sort().toString() === params.sort().toString()) {
        return Promise.resolve(_.pick(body, params));
      } else {
        return Promise.reject(new validate.errors.MissingField());
      }
    };
  };

  var fetchChangePasswordParams = fetchParams([
    'walletId',
    'salt',
    'kdfParams',
    'mainData',
    'mainDataHash',
    'keychainData',
    'keychainDataHash'
  ]);

  var fetchMainDataParams = fetchParams(['mainData', 'mainDataHash']);

  Promise.props({
       wallet: walletV2.getByWalletId(req.verified.username, req.verified.walletId),
       changes: Promise.any([fetchChangePasswordParams(), fetchMainDataParams()])
     })
    .then(function (params) {
      if (params.changes.walletId) {
        params.changes.walletId = new Buffer(params.changes.walletId || "", 'base64');
        params.changes.walletId = hash.sha2(params.changes.walletId);
      }
      return walletV2.update(params.wallet.id, body.lockVersion, params.changes);
    })
    .then (function(result) { 
      res.send({
        "status":         "success",
        "newLockVersion": result.newLockVersion
      }); 
    })
    .catch(errors.RecordNotFound,        missingFailer(res))
    .catch(validate.errors.MissingField, fieldFailer("missing_field", res))
    .catch(Promise.AggregateError, function(err) {
        fieldFailer("missing_field", res)(_.first(err));
    })
    .catch(validate.errors.InvalidHash,  fieldFailer("invalid_hash", res))
    .catch(next);
});

wallets.delete = signedJson.action(function(req, res, next) {
  return walletV2.getByWalletId(req.verified.username, req.verified.walletId)
    .then(function(wallet) {
      return walletV2.delete(wallet.id, req.verified.body.lockVersion);
    })
    .then(function() {
      res.send({"status": "success"});
    })
    .catch(
      errors.RecordNotFound,
      errors.Forbidden,
      function(err) {
        failForbidden(res);
      })
    .catch(next);
});

wallets.enableRecovery = signedJson.action(function(req, res, next) {
  var body = req.verified.body;

  var changes = _.pick(body, [
    'recoveryId',
    'recoveryData'
  ]);

  walletV2.getByWalletId(req.verified.username, req.verified.walletId)
    .then(function (wallet) {
      return walletV2.enableRecovery(wallet.id, body.lockVersion, changes);
    })
    .then (function(result) {
      res.send({
        "status":         "success",
        "newLockVersion": result.newLockVersion
      });
    })
    .catch(errors.RecordNotFound, missingFailer(res))
    .catch(validate.errors.MissingField, fieldFailer("missing", res))
    .catch(next);
});

wallets.showRecovery = [lockoutByIP, function(req, res, next) {
  return walletV2.get(req.body.username)
    .then(function checkRecoveryId(wallet) {
      if (!scmp(wallet.recoveryId, req.body.recoveryId)) {
        return Promise.reject(new errors.Forbidden());
      }
      return wallet;
    })
    .then(function checkTotpCode(wallet) {
      if(!walletV2.isTotpEnabled(wallet)) {
        return wallet;
      }
      var isValid = totp.verify(req.body.totpCode, wallet.totpKey);

      return isValid ? wallet : Promise.reject(new errors.Forbidden());
    })
    .then(function sendRecoveryData(wallet) {
      res.send({"status" : "success", "recoveryData": wallet.recoveryData});
      // TODO send email to the user in case someone has just compromised their account
    })
    .catch(
      errors.RecordNotFound,
      errors.Forbidden,
      function(err) {
        lockout.record(req.ip);
        failForbidden(res);
      });
}];

function fail(res, params) {
  params = _.extend({"status": "fail"}, params);
  res.status(400).send(params);
}

function failMissing(res) {
  res.status(404).send({ "status": "fail", "code": "not_found" });
}

function failForbidden(res) {
  res.status(403).send({ "status": "fail", "code": "forbidden" });
}

function fieldFailer(code, res) {
  return function(e) {
    fail(res, {
      "field":  e.field,
      "code":   code,
    });
  };
}

function missingFailer(res) {
  return function(e) {
    failMissing(res);
  };
}
