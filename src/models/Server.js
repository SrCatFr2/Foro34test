const mongoose = require('mongoose');
const crypto = require('crypto');

const ChannelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 32 },
    type: { type: String, default: 'text', enum: ['text', 'announce'] },
    topic: { type: String, default: '', maxlength: 200 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ServerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 40 },
    icon: { type: String, default: '' }, // single emoji or short string
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    channels: { type: [ChannelSchema], default: [] },
    inviteCode: {
      type: String,
      unique: true,
      sparse: true,
      default: () => crypto.randomBytes(6).toString('hex'),
    },
  },
  { timestamps: true },
);

ServerSchema.methods.toClientJSON = function toClientJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    icon: this.icon,
    ownerId: this.ownerId ? this.ownerId.toString() : null,
    members: (this.members || []).map((m) => m.toString()),
    channels: (this.channels || []).map((c) => ({
      id: c._id.toString(),
      name: c.name,
      type: c.type,
      topic: c.topic,
    })),
    inviteCode: this.inviteCode,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.models.Server || mongoose.model('Server', ServerSchema);
