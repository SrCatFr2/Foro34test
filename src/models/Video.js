const mongoose = require('mongoose');

// Author block is denormalized so a clip keeps rendering with the original
// avatar/name even if the user later changes their profile.
const VideoAuthorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    displayName: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
    color: { type: String, default: '#7c5cff' },
    decoration: { type: String, default: 'none' },
    nameFont: { type: String, default: 'default' },
  },
  { _id: false },
);

const VideoCommentSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, maxlength: 500 },
    author: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      username: { type: String, default: '' },
      displayName: { type: String, required: true },
      avatarUrl: { type: String, default: '' },
      color: { type: String, default: '#9aa0aa' },
      anonymous: { type: Boolean, default: true },
    },
    anonOwner: { type: String, default: '' },
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likedAnon: [{ type: String }],
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const VideoSchema = new mongoose.Schema(
  {
    caption: { type: String, default: '', maxlength: 500 },
    tags: [{ type: String, lowercase: true, maxlength: 24 }],

    // Cloudinary asset.
    videoUrl: { type: String, required: true },
    videoPublicId: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    duration: { type: Number, default: 0 }, // seconds
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },

    author: { type: VideoAuthorSchema, required: true },

    // Likes from registered users + anonymous viewers (hashed IP+UA).
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likedAnon: [{ type: String }],

    // Counter cached on the doc to avoid scanning likedBy on the feed.
    likeCount: { type: Number, default: 0, index: true },
    viewCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },

    // Recent comments are kept inline so the feed can show the latest few
    // without an extra query. The full list is paginated via the comments
    // endpoint. We cap the inline list to keep documents small.
    comments: { type: [VideoCommentSchema], default: [] },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Sort by recency for the chronological feed; lookups by user/feed pages.
VideoSchema.index({ createdAt: -1 });
VideoSchema.index({ 'author.username': 1, createdAt: -1 });

const INLINE_COMMENTS_CAP = 30;

function commentToClient(c) {
  return {
    id: c._id.toString(),
    text: c.text,
    author: {
      userId: c.author.userId ? c.author.userId.toString() : null,
      username: c.author.username || '',
      displayName: c.author.displayName,
      avatarUrl: c.author.avatarUrl || '',
      color: c.author.color || '#9aa0aa',
      anonymous: !!c.author.anonymous,
    },
    likeCount: (c.likedBy || []).length + (c.likedAnon || []).length,
    createdAt: c.createdAt,
  };
}

VideoSchema.methods.toClientJSON = function (viewer = {}) {
  const userId = viewer.userId || null;
  const anonId = viewer.anonId || '';
  const liked = userId
    ? (this.likedBy || []).some((id) => id.toString() === userId)
    : (anonId ? (this.likedAnon || []).includes(anonId) : false);
  const recent = (this.comments || []).slice(-3).map(commentToClient);
  return {
    id: this._id.toString(),
    caption: this.deletedAt ? '' : this.caption,
    tags: this.tags || [],
    videoUrl: this.deletedAt ? '' : this.videoUrl,
    thumbnailUrl: this.deletedAt ? '' : this.thumbnailUrl,
    duration: this.duration || 0,
    width: this.width || 0,
    height: this.height || 0,
    author: {
      userId: this.author.userId ? this.author.userId.toString() : null,
      username: this.author.username,
      displayName: this.author.displayName,
      avatarUrl: this.author.avatarUrl,
      color: this.author.color,
      decoration: this.author.decoration || 'none',
      nameFont: this.author.nameFont || 'default',
    },
    likeCount: this.likeCount || 0,
    viewCount: this.viewCount || 0,
    commentCount: this.commentCount || 0,
    liked: !!liked,
    recentComments: recent,
    createdAt: this.createdAt,
    deleted: !!this.deletedAt,
  };
};

VideoSchema.methods.appendComment = function (comment) {
  this.comments.push(comment);
  if (this.comments.length > INLINE_COMMENTS_CAP) {
    this.comments = this.comments.slice(-INLINE_COMMENTS_CAP);
  }
  this.commentCount = (this.commentCount || 0) + 1;
};

VideoSchema.statics.INLINE_COMMENTS_CAP = INLINE_COMMENTS_CAP;

module.exports = mongoose.models.Video || mongoose.model('Video', VideoSchema);
