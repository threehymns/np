import Parser from 'web-tree-sitter';
import path from 'path';
import fs from 'fs';

async function test() {
  await Parser.init();
  const parser = new Parser();
  const Lang = await Parser.Language.load('static/wasm/tree-sitter-markdown.wasm');
  parser.setLanguage(Lang);

  const text = '# Heading 1\n**Bold Text**\n- List Item 1';
  const tree = parser.parse(text);

  function printNode(node, indent = '') {
    console.log(`${indent}${node.type} [${node.startIndex}-${node.endIndex}]`);
    for (let i = 0; i < node.childCount; i++) {
      printNode(node.child(i), indent + '  ');
    }
  }

  printNode(tree.rootNode);
}

test();
