// The capture surfaces' comment box (ADR 0011): the one-line box Object Select and Select Text open beside what the
// reviewer chose, and the draw note that asks for a typed note on a drawn Annotation in a Session without voice. They
// render into the overlay host's React root (mountSurfaces, ../toolbar), driven through handles.
export {
  type BoxAnchor,
  type BoxDictationMode,
  type BoxTheme,
  CommentBox,
  type CommentBoxHandle,
  type CommentBoxOptions,
  type CommentBoxProps,
  connectDictation,
  type DictationHost,
  type DictationWords,
  type MountedCommentBox,
  mountCommentBox,
  receiveDictation,
} from './comment-box';
export {
  DrawNote,
  type DrawNoteHandle,
  type DrawNoteProps,
  type MountedDrawNote,
  mountDrawNote,
  type NoteAnchor,
} from './draw-note';
