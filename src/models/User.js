const mongoose = require('mongoose');

const DECORATIONS = [
  'none', 'neon', 'fire', 'rainbow', 'stars', 'glow', 'gold', 'aurora', 'ice', 'shadow',
  // v2 — more detail
  'galaxy', 'sakura', 'cyber', 'royal', 'ocean', 'crown', 'halo', 'ember', 'lightning', 'matrix',
];
const EFFECTS = [
  'none', 'pulse', 'sparkle', 'wave', 'shake',
  // v2
  'glitch', 'rainbowHue', 'float', 'confetti', 'glow',
];
const NAME_FONTS = [
  'default', 'pixel', 'serif', 'mono', 'cursive', 'marker', 'retro', 'fancy',
];

const NotificationSchema = new mongoose.Schema(
  {
    type: { type: String, default: 'mention' }, // mention | system
    msgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    fromUsername: { type: String, default: '' },
    fromDisplayName: { type: String, default: '' },
    text: { type: String, default: '', maxlength: 200 },
    room: { type: String, default: 'global' },
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const LinkSchema = new mongoose.Schema(
  {
    label: { type: String, maxlength: 30, default: '' },
    url: { type: String, maxlength: 200, default: '' },
  },
  { _id: false },
);

const StickerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 32 },
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const AchievementSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    unlockedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Integrations are stored on the user doc so we don't need a separate collection.
// Tokens are kept server-side only (toPublicJSON omits them).
const SpotifyIntegrationSchema = new mongoose.Schema(
  {
    connected: { type: Boolean, default: false },
    spotifyId: { type: String, default: '' },
    displayName: { type: String, default: '' },
    profileUrl: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    expiresAt: { type: Date, default: null },
    scope: { type: String, default: '' },
  },
  { _id: false },
);

const BrawlStarsBrawlerSchema = new mongoose.Schema(
  {
    id: { type: Number, default: 0 },
    name: { type: String, default: '' },
    power: { type: Number, default: 0 },
    rank: { type: Number, default: 0 },
    trophies: { type: Number, default: 0 },
    highestTrophies: { type: Number, default: 0 },
  },
  { _id: false },
);

const BrawlStarsIntegrationSchema = new mongoose.Schema(
  {
    connected: { type: Boolean, default: false },
    tag: { type: String, default: '' }, // normalized like "#YYY..."
    name: { type: String, default: '' },
    trophies: { type: Number, default: 0 },
    highestTrophies: { type: Number, default: 0 },
    expLevel: { type: Number, default: 0 },
    brawlersUnlocked: { type: Number, default: 0 },
    threeVsThreeVictories: { type: Number, default: 0 },
    soloVictories: { type: Number, default: 0 },
    duoVictories: { type: Number, default: 0 },
    club: {
      tag: { type: String, default: '' },
      name: { type: String, default: '' },
    },
    iconId: { type: Number, default: 0 },
    topBrawlers: { type: [BrawlStarsBrawlerSchema], default: [] },
    fetchedAt: { type: Date, default: null },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
      match: /^[a-z0-9_]+$/,
    },
    displayName: { type: String, required: true, maxlength: 40 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    avatarUrl: { type: String, default: '' },
    avatarPublicId: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },
    bannerPublicId: { type: String, default: '' },

    bio: { type: String, default: '', maxlength: 500 },
    color: { type: String, default: '#7c5cff' }, // accent / name color
    bannerColor: { type: String, default: '#1b1f27' }, // fallback when no banner image
    gradientFrom: { type: String, default: '#7c5cff' },
    gradientTo: { type: String, default: '#ff5c8a' },

    decoration: { type: String, enum: DECORATIONS, default: 'none' },
    effect: { type: String, enum: EFFECTS, default: 'none' },

    pronouns: { type: String, default: '', maxlength: 30 },
    status: { type: String, default: '', maxlength: 80 },
    title: { type: String, default: '', maxlength: 30 }, // small badge above name
    nameFont: { type: String, enum: NAME_FONTS, default: 'default' },

    links: { type: [LinkSchema], default: [] },

    pinnedMessageIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }],
    notifications: { type: [NotificationSchema], default: [] },
    stickers: { type: [StickerSchema], default: [] },
    achievements: { type: [AchievementSchema], default: [] },
    stats: {
      messages: { type: Number, default: 0 },
      reactionsReceived: { type: Number, default: 0 },
      voiceNotes: { type: Number, default: 0 },
      polls: { type: Number, default: 0 },
      images: { type: Number, default: 0 },
      stickersUsed: { type: Number, default: 0 },
    },
    integrations: {
      spotify: { type: SpotifyIntegrationSchema, default: () => ({}) },
      brawlStars: { type: BrawlStarsIntegrationSchema, default: () => ({}) },
    },
  },
  { timestamps: true },
);

UserSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    username: this.username,
    displayName: this.displayName,
    avatarUrl: this.avatarUrl,
    bannerUrl: this.bannerUrl,
    bio: this.bio,
    color: this.color,
    bannerColor: this.bannerColor,
    gradientFrom: this.gradientFrom,
    gradientTo: this.gradientTo,
    decoration: this.decoration,
    effect: this.effect,
    pronouns: this.pronouns,
    status: this.status,
    title: this.title,
    nameFont: this.nameFont || 'default',
    links: (this.links || []).map((l) => ({ label: l.label || '', url: l.url || '' })),
    pinnedMessageIds: (this.pinnedMessageIds || []).map((id) => id.toString()),
    achievements: (this.achievements || []).map((a) => ({ key: a.key, unlockedAt: a.unlockedAt })),
    stats: this.stats || {},
    integrations: {
      spotify: {
        connected: !!(this.integrations && this.integrations.spotify && this.integrations.spotify.connected),
        displayName: (this.integrations && this.integrations.spotify && this.integrations.spotify.displayName) || '',
        profileUrl: (this.integrations && this.integrations.spotify && this.integrations.spotify.profileUrl) || '',
        avatarUrl: (this.integrations && this.integrations.spotify && this.integrations.spotify.avatarUrl) || '',
      },
      brawlStars: (() => {
        const bs = (this.integrations && this.integrations.brawlStars) || {};
        return {
          connected: !!bs.connected,
          tag: bs.tag || '',
          name: bs.name || '',
          trophies: bs.trophies || 0,
          highestTrophies: bs.highestTrophies || 0,
          expLevel: bs.expLevel || 0,
          brawlersUnlocked: bs.brawlersUnlocked || 0,
          threeVsThreeVictories: bs.threeVsThreeVictories || 0,
          soloVictories: bs.soloVictories || 0,
          duoVictories: bs.duoVictories || 0,
          club: bs.club || { tag: '', name: '' },
          iconId: bs.iconId || 0,
          topBrawlers: (bs.topBrawlers || []).map((b) => ({
            id: b.id || 0,
            name: b.name || '',
            power: b.power || 0,
            rank: b.rank || 0,
            trophies: b.trophies || 0,
            highestTrophies: b.highestTrophies || 0,
          })),
        };
      })(),
    },
    createdAt: this.createdAt,
  };
};

UserSchema.methods.stickersForClient = function () {
  return (this.stickers || []).map((s) => ({
    id: s._id.toString(),
    name: s.name,
    url: s.url,
  }));
};

UserSchema.statics.DECORATIONS = DECORATIONS;
UserSchema.statics.EFFECTS = EFFECTS;
UserSchema.statics.NAME_FONTS = NAME_FONTS;

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
