var slots = require('../helpers/slots.js'),
	ed = require('ed25519'),
	crypto = require('crypto'),
	genesisblock = require("../helpers/genesisblock.js"),
	constants = require('../helpers/constants.js'),
	ByteBuffer = require("bytebuffer"),
	bignum = require('../helpers/bignum.js'),
	extend = require('util-extend');

//constructor
function Transaction(scope, cb) {
	this.scope = scope;
	cb && setImmediate(cb, null, this);
}

//private methods
var private = {};
private.types = {};

//public methods
Transaction.prototype.create = function (data) {
	if (!private.types[data.type]) {
		throw Error('Unknown transaction type ' + data.type);
	}

	if (!data.sender) {
		throw Error("Can't find sender");
	}

	if (!data.keypair) {
		throw Error("Can't find keypair");
	}

	var trs = {
		type: data.type,
		amount: 0,
		senderPublicKey: data.sender.publicKey,
		requesterPublicKey: data.requester? data.requester.publicKey : null,
		timestamp: slots.getTime(),
		asset: {}
	};

	trs = private.types[trs.type].create.call(this, data, trs);

	trs.signature = this.sign(data.keypair, trs);

	if (data.sender.secondSignature && data.secondKeypair) {
		trs.signSignature = this.sign(data.secondKeypair, trs);
	}

	trs.id = this.getId(trs);

	trs.fee = private.types[trs.type].calculateFee.call(this, trs) || false;

	return trs;
}

Transaction.prototype.attachAssetType = function (typeId, instance) {
	if (instance && typeof instance.create == 'function' && typeof instance.getBytes == 'function' &&
		typeof instance.calculateFee == 'function' && typeof instance.verify == 'function' &&
		typeof instance.objectNormalize == 'function' && typeof instance.dbRead == 'function' &&
		typeof instance.apply == 'function' && typeof instance.undo == 'function' &&
		typeof instance.applyUnconfirmed == 'function' && typeof instance.undoUnconfirmed == 'function' &&
		typeof instance.ready == 'function' && typeof instance.process == 'function'
	) {
		private.types[typeId] = instance;
	} else {
		throw Error('Invalid instance interface');
	}
}

Transaction.prototype.sign = function (keypair, trs) {
	var hash = this.getHash(trs);
	return ed.Sign(hash, keypair).toString('hex');
}

Transaction.prototype.getId = function (trs) {
	var hash = this.getHash(trs);
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = hash[7 - i];
	}

	var id = bignum.fromBuffer(temp).toString();
	return id;
}

Transaction.prototype.getHash = function (trs) {
	return crypto.createHash('sha256').update(this.getBytes(trs)).digest();
}

Transaction.prototype.getBytes = function (trs, skipSignature, skipSecondSignature) {
	if (!private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	try {
		var assetBytes = private.types[trs.type].getBytes.call(this, trs, skipSignature, skipSecondSignature);
		var assetSize = assetBytes ? assetBytes.length : 0;

		var bb = new ByteBuffer(1 + 4 + 32 + 32 + 8 + 8 + 64 + 64 + assetSize, true);
		bb.writeByte(trs.type);
		bb.writeInt(trs.timestamp);

		var senderPublicKeyBuffer = new Buffer(trs.senderPublicKey, 'hex');
		for (var i = 0; i < senderPublicKeyBuffer.length; i++) {
			bb.writeByte(senderPublicKeyBuffer[i]);
		}

		if (trs.requesterPublicKey) {
			var requesterPublicKey = new Buffer(trs.requesterPublicKey, 'hex');
			for (var i = 0; i < requesterPublicKey.length; i++) {
				bb.writeByte(requesterPublicKey[i]);
			}
		}

		if (trs.recipientId) {
			var recipient = trs.recipientId.slice(0, -1);
			recipient = bignum(recipient).toBuffer({size: 8});

			for (var i = 0; i < 8; i++) {
				bb.writeByte(recipient[i] || 0);
			}
		} else {
			for (var i = 0; i < 8; i++) {
				bb.writeByte(0);
			}
		}

		bb.writeLong(trs.amount);

		if (assetSize > 0) {
			for (var i = 0; i < assetSize; i++) {
				bb.writeByte(assetBytes[i]);
			}
		}

		if (!skipSignature && trs.signature) {
			var signatureBuffer = new Buffer(trs.signature, 'hex');
			for (var i = 0; i < signatureBuffer.length; i++) {
				bb.writeByte(signatureBuffer[i]);
			}
		}

		if (!skipSecondSignature && trs.signSignature) {
			var signSignatureBuffer = new Buffer(trs.signSignature, 'hex');
			for (var i = 0; i < signSignatureBuffer.length; i++) {
				bb.writeByte(signSignatureBuffer[i]);
			}
		}

		bb.flip();
	} catch (e) {
		throw Error(e.toString());
	}
	return bb.toBuffer();
}

Transaction.prototype.ready = function (trs, sender) {
	if (!private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	if (!sender) {
		return false;
	}

	return private.types[trs.type].ready.call(this, trs, sender);
}

Transaction.prototype.process = function (trs, sender, cb) {
	if (!private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	/*
	if (!this.ready(trs, sender)) {
		return setImmediate(cb, "Transaction is not ready: " + trs.id);
	}
	*/

	try {
		var txId = this.getId(trs);
	} catch (e) {
		return setImmediate(cb, "Invalid transaction id");
	}
	if (trs.id && trs.id != txId) {
		return setImmediate(cb, "Invalid transaction id");
	} else {
		trs.id = txId;
	}

	if (!sender) {
		return setImmediate(cb, "Can't process transaction, sender not found");
	}

	trs.senderId = sender.address;


	// verify that requester in multisignature
	if (trs.requesterPublicKey) {
		if (sender.multisignatures.indexOf(trs.requesterPublicKey) < 0) {
			return setImmediate(cb, "Can't verify requester signature");
		}
	}

	if (trs.requesterPublicKey) {
		if (!this.verifySignature(trs.requesterPublicKey, trs.signature)) {
			return setImmediate(cb, "Can't verify signature");
		}
	}
	else {
		if (!this.verifySignature(trs, trs.senderPublicKey, trs.signature)) {
			return setImmediate(cb, "Can't verify signature");
		}
	}

	private.types[trs.type].process.call(this, trs, sender, function (err, trs) {
		if (err) {
			return setImmediate(cb, err);
		}

		this.scope.dbLite.query("SELECT count(id) FROM trs WHERE id=$id", {id: trs.id}, {"count": Number}, function (err, rows) {
			if (err) {
				return cb("Internal sql error");
			}

			var res = rows.length && rows[0];

			if (res.count) {
				return cb("Can't process transaction, transaction already confirmed");
			}

			cb(null, trs);
		});
	}.bind(this));
}

Transaction.prototype.verify = function (trs, sender, cb) { //inheritance
	if (!private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	if (!this.ready(trs, sender)) {
		return setImmediate(cb, "Transaction is not ready: " + trs.id);
	}

	//check sender
	if (!sender) {
		return setImmediate(cb, "Can't find sender");
	}

	if (trs.requesterPublicKey) {
		if (sender.multisignatures.indexOf(trs.requesterPublicKey) < 0) {
			return setImmediate(cb, "Can't verify requester signature");
		}
	}

	//verify signature
	try {
		var valid = false;

		if (trs.requesterPublicKey) {
			valid = this.verifySignature(trs, trs.requesterPublicKey, trs.signature);
		} else {
			valid = this.verifySignature(trs, trs.senderPublicKey, trs.signature);
		}
	} catch (e) {
		return setImmediate(cb, e.toString());
	}
	if (!valid) {
		return setImmediate(cb, "Can't verify signature");
	}

	//verify second signature
	if (sender.secondSignature) {
		try {
			var valid = this.verifySecondSignature(trs, sender.secondPublicKey, trs.signSignature);
		} catch (e) {
			return setImmediate(cb, e.toString());
		}
		if (!valid) {
			return setImmediate(cb, "Can't verify second signature: " + trs.id);
		}
	}

	for (var s = 0; s < sender.multisignatures.length; s++) {
		verify = false;

		if (trs.signatures) {
			for (var d = 0; d < trs.signatures.length && !verify; d++) {
				if (this.verifySecondSignature(trs, sender.multisignatures[s], trs.signatures[d])) {
					verify = true;
				}
			}
		}

		if (!verify) {
			return setImmediate(cb, "Failed multisignature: " + trs.id);
		}
	}

	//check sender
	if (trs.senderId != sender.address) {
		return setImmediate(cb, "Invalid sender id: " + trs.id);
	}

	//calc fee
	var fee = private.types[trs.type].calculateFee.call(this, trs) || false;
	if (!fee || trs.fee != fee) {
		return setImmediate(cb, "Invalid transaction type/fee: " + trs.id);
	}
	//check amount
	if (trs.amount < 0 || trs.amount > 100000000 * constants.fixedPoint || String(trs.amount).indexOf('.') >= 0 || trs.amount.toString().indexOf('e') >= 0) {
		return setImmediate(cb, "Invalid transaction amount: " + trs.id);
	}
	//check timestamp
	if (slots.getSlotNumber(trs.timestamp) > slots.getSlotNumber()) {
		return setImmediate(cb, "Invalid transaction timestamp");
	}

	//spec
	private.types[trs.type].verify.call(this, trs, sender, function (err) {
		cb(err);
	});
}

Transaction.prototype.verifySignature = function (trs, publicKey, signature) {
	if (!private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	if (!signature) return false;

	try {
		var bytes = this.getBytes(trs, true, true);
		var res = this.verifyBytes(bytes, publicKey, signature);
	} catch (e) {
		throw Error(e.toString());
	}

	return res;
}

Transaction.prototype.verifySecondSignature = function (trs, publicKey, signature) {
	if (!private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	if (!signature) return false;

	try {
		var bytes = this.getBytes(trs, false, true);
		var res = this.verifyBytes(bytes, publicKey, signature);
	} catch (e) {
		throw Error(e.toString());
	}

	return res;
}

Transaction.prototype.verifyBytes = function (bytes, publicKey, signature) {
	try {
		var data2 = new Buffer(bytes.length);

		for (var i = 0; i < data2.length; i++) {
			data2[i] = bytes[i];
		}

		var hash = crypto.createHash('sha256').update(data2).digest();
		var signatureBuffer = new Buffer(signature, 'hex');
		var publicKeyBuffer = new Buffer(publicKey, 'hex');
		var res = ed.Verify(hash, signatureBuffer || ' ', publicKeyBuffer || ' ');
	} catch (e) {
		throw Error(e.toString());
	}

	return res;
}

Transaction.prototype.apply = function (trs, sender, cb) {
	if (!private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	if (!this.ready(trs, sender)) {
		return setImmediate(cb, "Transaction is not ready: " + trs.id);
	}

	var amount = trs.amount + trs.fee;

	if (trs.blockId != genesisblock.block.id && sender.balance < amount) {
		return setImmediate(cb, "Balance has no XCR: " + trs.id);
	}

	this.scope.account.merge(sender.address, {balance: -amount}, function (err, sender) {
		if (err) {
			return cb(err);
		}

		private.types[trs.type].apply.call(this, trs, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {balance: amount}, cb);
			} else {
				setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
}

Transaction.prototype.undo = function (trs, sender, cb) {
	if (!private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	var amount = trs.amount + trs.fee;

	this.scope.account.merge(sender.address, {balance: amount}, function (err, sender) {
		if (err) {
			return cb(err);
		}

		private.types[trs.type].undo.call(this, trs, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {balance: amount}, cb);
			} else {
				setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
}

Transaction.prototype.applyUnconfirmed = function (trs, sender, cb) {
	if (!private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	if (sender.secondSignature && !trs.signSignature) {
		return setImmediate(cb, 'Failed second signature: ' + trs.id);
	}

	if (!sender.secondSignature && (trs.signSignature && trs.signSignature.length > 0)) {
		return setImmediate(cb, "Account doesn't have second signature");
	}

	var amount = trs.amount + trs.fee;

	if (sender.u_balance < amount && trs.blockId != genesisblock.block.id) {
		return setImmediate(cb, 'Account has no balance: ' + trs.id);
	}

	this.scope.account.merge(sender.address, {u_balance: -amount}, function (err, sender) {
		if (err) {
			return cb(err);
		}

		private.types[trs.type].applyUnconfirmed.call(this, trs, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {u_balance: amount}, function (err2) {
					cb(err);
				});
			} else {
				setImmediate(cb, err);
			}
		}.bind(this));
	}.bind(this));
}

Transaction.prototype.undoUnconfirmed = function (trs, sender, cb) {
	if (!private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	var amount = trs.amount + trs.fee;

	this.scope.account.merge(sender.address, {u_balance: amount}, function (err, sender) {
		if (err) {
			return cb(err);
		}

		private.types[trs.type].undoUnconfirmed.call(this, trs, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {u_balance: -amount}, cb);
			} else {
				setImmediate(cb, err);
			}
		}.bind(this));
	}.bind(this));
}

Transaction.prototype.dbSave = function (trs, cb) {
	if (!private.types[trs.type]) {
		return cb('Unknown transaction type ' + trs.type);
	}

	try {
		var senderPublicKey = new Buffer(trs.senderPublicKey, 'hex');
		var signature = new Buffer(trs.signature, 'hex');
		var signSignature = trs.signSignature ? new Buffer(trs.signSignature, 'hex') : null;
	} catch (e) {
		return cb(e.toString())
	}

	this.scope.dbLite.query("INSERT INTO trs(id, blockId, type, timestamp, senderPublicKey, senderId, recipientId, senderUsername, recipientUsername, amount, fee, signature, signSignature, signatures) VALUES($id, $blockId, $type, $timestamp, $senderPublicKey, $senderId, $recipientId, $senderUsername, $recipientUsername, $amount, $fee, $signature, $signSignature, $signatures)", {
		id: trs.id,
		blockId: trs.blockId,
		type: trs.type,
		timestamp: trs.timestamp,
		senderPublicKey: senderPublicKey,
		senderId: trs.senderId,
		recipientId: trs.recipientId || null,
		senderUsername: trs.senderUsername || null,
		recipientUsername: trs.recipientUsername || null,
		amount: trs.amount,
		fee: trs.fee,
		signature: signature,
		signSignature: signSignature,
		signatures: trs.signatures ? trs.signatures.join(',') : null
	}, function (err) {
		if (err) {
			return cb(err);
		}

		private.types[trs.type].dbSave.call(this, trs, cb);
	}.bind(this));

}

Transaction.prototype.objectNormalize = function (trs) {
	if (!private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	for (var i in trs) {
		if (trs[i] === null || typeof trs[i] === 'undefined') {
			delete trs[i];
		}
	}

	var report = this.scope.scheme.validate(trs, {
		object: true,
		properties: {
			id: {
				type: "string"
			},
			height: {
				type: "integer"
			},
			blockId: {
				type: "string"
			},
			type: {
				type: "integer"
			},
			timestamp: {
				type: "integer"
			},
			senderPublicKey: {
				type: "string",
				format: "publicKey"
			},
			requesterPublicKey: {
				type: "string",
				format: "publicKey"
			},
			senderId: {
				type: "string"
			},
			recipientId: {
				type: "string"
			},
			senderUsername: {
				type: "string"
			},
			recipientUsername: {
				type: "string"
			},
			amount: {
				type: "integer",
				minimum: 0,
				maximum: constants.totalAmount
			},
			fee: {
				type: "integer",
				minimum: 0,
				maximum: constants.totalAmount
			},
			signature: {
				type: "string",
				format: "signature"
			},
			signSignature: {
				type: "string",
				format: "signature"
			},
			asset: {
				type: "object"
			}
		},
		required: ['type', 'timestamp', 'senderPublicKey', 'signature']
	});

	if (!report) {
		throw Error(this.scope.scheme.getLastError());
	}

	try {
		trs = private.types[trs.type].objectNormalize.call(this, trs);
	} catch (e) {
		throw Error(e.toString());
	}

	return trs;
}

Transaction.prototype.dbRead = function (raw) {
	if (!raw.t_id) {
		return null
	} else {
		var tx = {
			id: raw.t_id,
			height: raw.b_height,
			blockId: raw.b_id,
			type: parseInt(raw.t_type),
			timestamp: parseInt(raw.t_timestamp),
			senderPublicKey: raw.t_senderPublicKey,
			requesterPublicKey: raw.t_requesterPublicKey,
			senderId: raw.t_senderId,
			recipientId: raw.t_recipientId,
			senderUsername: raw.t_senderUsername,
			recipientUsername: raw.t_recipientUsername,
			amount: parseInt(raw.t_amount),
			fee: parseInt(raw.t_fee),
			signature: raw.t_signature,
			signSignature: raw.t_signSignature,
			signatures: raw.t_signatures ? raw.t_signatures.split(',') : null,
			confirmations: raw.confirmations,
			asset: {}
		}

		if (!private.types[tx.type]) {
			throw Error('Unknown transaction type ' + tx.type);
		}

		var asset = private.types[tx.type].dbRead.call(this, raw);

		if (asset) {
			tx.asset = extend(tx.asset, asset);
		}

		return tx;
	}
}

//export
module.exports = Transaction;