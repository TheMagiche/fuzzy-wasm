//! `$and` / `$or` / `$path` query trees.
//!
//! The TypeScript side ports Fuse's parser (including the quirk that a bare
//! object becomes an `$and`, and that a top-level `$path` is split before it
//! can be seen). What arrives here is the already-parsed tree.

use crate::buf::Reader;

#[derive(Debug)]
pub enum QueryNode {
    Leaf {
        /// `-1` searches every key. `< -1` is a key id Fuse does not know.
        key_index: i32,
        pattern: Vec<u16>,
    },
    And(Vec<QueryNode>),
    Or(Vec<QueryNode>),
}

pub fn decode_query(data: &[u8]) -> Result<QueryNode, String> {
    let mut reader = Reader::new(data);
    let node = read_node(&mut reader)?;
    if reader.remaining() != 0 {
        return Err("trailing bytes in logical query".into());
    }
    Ok(node)
}

fn read_node(reader: &mut Reader<'_>) -> Result<QueryNode, String> {
    match reader.u8()? {
        0 => Ok(QueryNode::Leaf {
            key_index: reader.i32()?,
            pattern: reader.utf16()?,
        }),
        1 => Ok(QueryNode::And(read_children(reader)?)),
        2 => Ok(QueryNode::Or(read_children(reader)?)),
        other => Err(format!("unknown logical node tag {other}")),
    }
}

fn read_children(reader: &mut Reader<'_>) -> Result<Vec<QueryNode>, String> {
    let count = reader.u32()? as usize;
    let mut children = Vec::with_capacity(count);
    for _ in 0..count {
        children.push(read_node(reader)?);
    }
    Ok(children)
}
