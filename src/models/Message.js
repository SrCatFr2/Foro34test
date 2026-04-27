const mongoose = require('mongoose');

const ReactionSchema = new mongoose.Schema(
  {
    emoji: { type: String, required: true, maxlength: 16 },
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Anonymous reactions are tracked by an opaque id derived from IP
    // so they can toggle their own reaction back off in the same session.
    anonIds: [{ type: String }],
  },
  { _id: false },
);

const PollOptionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, maxlength: 80 },
    voterIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    voterAnonIds: [{ type: String }],
  },
  { _id: false },
);

const PollSchema = new mongoose.Schema(
  {
    question: { type: String, default: '', maxlength: 200 },
    options: { type: [PollOptionSchema], default: [] },
    multiple: { type: Boolean, default: false },
  },
  { _id: false },
);

const ReplyToSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    authorDisplayName: { type: String, default: '' },
    authorColor: { type: String, default: '' },
    snippet: { type: String, default: '', maxlength: 140 },
    snippetImage: { type: String, default: '' },
  },
  { _id: false },
);

const MessageSchema = new mongoose.Schema(
  {
    text: { type: String, default: '', maxlength: 2000 },
    imageUrl: { type: String, default: '' },
    imagePublicId: { type: String, default: '' },
    // Voice note (audio) attachment
    audioUrl: { type: String, default: '' },
    audioPublicId: { type: String, default: '' },
    audioDuration: { type: Number, default: 0 }, // seconds
    // Sticker reference (when message represents a sticker send)
    sticker: {
      url: { type: String, default: '' },
      name: { type: String, default: '' },
      ownerUsername: { type: String, default: '' },
    },
    // 'message' = normal user msg, 'system' = bot/command result, 'poll' = poll msg
    kind: { type: String, default: 'message', enum: ['message', 'system', 'poll'] },
    // Action-style messages (rendered italic, no avatar bubble)
    isAction: { type: Boolean, default: false },
    // Author info denormalized so anonymous messages and historic ones still render
    // even if the user changes their profile.
    author: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      username: { type: String, default: '' },
      displayName: { type: String, required: true },
      avatarUrl: { type: String, default: '' },
      color: { type: String, default: '#7c5cff' },
      decoration: { type: String, default: 'none' },
      effect: { type: String, default: 'none' },
      nameFont: { type: String, default: 'default' },
      anonymous: { type: Boolean, default: true },
      bot: { type: Boolean, default: false },
    },
    // Anonymous client id (hashed IP+UA) so anon owners can edit/delete their own
    // messages within the same session.
    anonOwner: { type: String, default: '' },
    room: { type: String, default: 'global', index: true },
    reactions: { type: [ReactionSchema], default: [] },
    replyTo: { type: ReplyToSchema, default: null },
    mentions: [{ type: String }], // lowercased usernames
    poll: { type: PollSchema, default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

MessageSchema.index({ createdAt: -1 });

MessageSchema.methods.toClientJSON = function () {
  const reactions = (this.reactions || []).map((r) => ({
    emoji: r.emoji,
    count: (r.userIds || []).length + (r.anonIds || []).length,
    userIds: (r.userIds || []).map((id) => id.toString()),
    anonIds: r.anonIds || [],
  }));
  const poll = this.poll
    ? {
        question: this.poll.question,
        multiple: !!this.poll.multiple,
        options: (this.poll.options || []).map((o) => ({
          text: o.text,
          count: (o.voterIds || []).length + (o.voterAnonIds || []).length,
          voterIds: (o.voterIds || []).map((id) => id.toString()),
          voterAnonIds: o.voterAnonIds || [],
        })),
      }
    : null;
  return {
    id: this._id.toString(),
    text: this.deletedAt ? '' : this.text,
    imageUrl: this.deletedAt ? '' : this.imageUrl,
    audioUrl: this.deletedAt ? '' : this.audioUrl,
    audioDuration: this.audioDuration || 0,
    sticker: this.sticker && this.sticker.url && !this.deletedAt
      ? { url: this.sticker.url, name: this.sticker.name, ownerUsername: this.sticker.ownerUsername }
      : null,
    kind: this.kind,
    isAction: this.isAction,
    author: {
      userId: this.author.userId ? this.author.userId.toString() : null,
      username: this.author.username,
      displayName: this.author.displayName,
      avatarUrl: this.author.avatarUrl,
      color: this.author.color,
      decoration: this.author.decoration || 'none',
      effect: this.author.effect || 'none',
      nameFont: this.author.nameFont || 'default',
      anonymous: this.author.anonymous,
      bot: !!this.author.bot,
    },
    anonOwner: this.anonOwner || '',
    room: this.room,
    reactions,
    replyTo: this.replyTo
      ? {
          id: this.replyTo.id ? this.replyTo.id.toString() : null,
          authorDisplayName: this.replyTo.authorDisplayName,
          authorColor: this.replyTo.authorColor,
          snippet: this.replyTo.snippet,
          snippetImage: this.replyTo.snippetImage,
        }
      : null,
    mentions: this.mentions || [],
    poll,
    editedAt: this.editedAt,
    deletedAt: this.deletedAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);
