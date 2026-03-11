declare module "diff-match-patch" {
  type Diff = [number, string];

  class diff_match_patch {
    diff_main(text1: string, text2: string): Diff[];
    patch_make(text1: string, text2: string): Patch[];
    patch_apply(patches: Patch[], text: string): [string, boolean[]];
  }

  interface Patch {
    diffs: Diff[];
    start1: number;
    start2: number;
    length1: number;
    length2: number;
  }

  export default diff_match_patch;
}
