//! Little-endian cursor shared by the record blob and the result blob.

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| format!("truncated buffer at {}, need {n} bytes", self.pos))?;
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    pub fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }

    pub fn i32(&mut self) -> Result<i32, String> {
        let bytes = self.take(4)?;
        Ok(i32::from_le_bytes(bytes.try_into().unwrap()))
    }

    pub fn f64(&mut self) -> Result<f64, String> {
        let bytes = self.take(8)?;
        Ok(f64::from_le_bytes(bytes.try_into().unwrap()))
    }

    pub fn utf16(&mut self) -> Result<Vec<u16>, String> {
        let len = self.u32()? as usize;
        let bytes = self.take(len.checked_mul(2).ok_or("utf16 length overflow")?)?;
        let mut units = Vec::with_capacity(len);
        for chunk in bytes.as_chunks::<2>().0 {
            units.push(u16::from_le_bytes(*chunk));
        }
        Ok(units)
    }
}

pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
    }

    pub fn u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn i32(&mut self, value: i32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f64(&mut self, value: f64) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}
