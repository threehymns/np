# Per-language overrides layer across scopes by language name

`editor.languages` holds one override object per language name, and it layers across the user and workspace scopes the way every other setting layers: the two scopes' maps are folded together, per language and per key, and the workspace wins. Language names fold case-insensitively, because that is how the fold that reads the map matches them, and the two have to agree.

## A language name is an identity, not a key

The map merges by language name rather than by JSON key. A user scope that says `Markdown` and a workspace scope that says `markdown` name the same language, so they become one entry, and the workspace's value wins inside it.

A deep merge on exact key spelling keeps both keys, and the reader takes the first match it finds, which is the user's, so the workspace cannot override the user at all. That was the shape this change had first, and it is the shape a reader is most likely to expect, which is why it is worth saying that the merge has to fold. Folding keeps the first spelling it sees and lets the higher scope win per key inside each language's entry.

## The alternatives that were not taken

Normalising the language names to lower case would fold them too, and it would rewrite the spelling in a file the user can still read and edit. The casing is what the user wrote, and the merge keeps it.

Making the resolver language-aware is the shape that would let provenance name a language as well as a scope. ADR 0014 resolves one key at one scope and reports provenance alongside the effective value, and a language is a third axis that report has no room for. The fold already applies the resolved map, so the question a reader asks of `editor.languages` (what does this language get) is answered without one. The cost is that provenance names the scope that produced the resolved map rather than the scope each language's values came from: the resolved map reports the workspace as soon as the workspace holds any map at all, including for the languages the workspace never mentions.

## What the settings page writes back

The settings page renders the effective map, so the folded map is what the user sees, and saving writes what it sees into the scope the page is editing. The page should edit that scope's own map instead, so that inherited entries are never written into the scope being edited. That is a separate change and this ADR does not make it.

## What is asserted, and where

The merge is asserted on the resolver, because the resolver is where the scopes are combined: a user-scope override for one language survives a workspace-scope override for another, the same language's overrides merge across scopes key by key, the workspace wins the key both scopes name, names that differ only in case become one entry, and a map that is not an object is skipped rather than thrown on. The fold's own side is asserted separately, on the function that reads the resolved map, so the case-insensitive agreement between the merge and the fold is pinned from both ends.
